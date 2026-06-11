import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../contexts/AuthContext';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { ChatThread } from '../types';
import { isCoach } from '../utils/helpers';
import { uploadToR2 } from '../utils/r2Upload';
import AppIcon from '../components/common/AppIcon';

interface WallPost {
  id: string;
  threadId: string;
  threadTitle: string;
  content: string;
  senderId?: string;
  senderName: string;
  senderRole?: string;
  timestamp: Date;
  attachments?: Array<{ url: string; type?: string; name?: string }>;
  reactions?: Array<{ emoji: string; userId: string; userName?: string }>;
  /** When set, this post sticks to the top of the wall, ordered by
   *  the timestamp here (most-recently pinned first). */
  wallPinnedTop?: number | null;
}

// Render URLs in plain text as tappable links. Plain-loop variant so
// we don't need the matchAll iterator target.
function linkify(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const re = /(https?:\/\/[^\s]+)/g;
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <a
        key={`l-${i++}`}
        href={m[0]}
        target="_blank"
        rel="noopener noreferrer"
        className="text-cyan-600 underline break-all"
      >
        {m[0]}
      </a>
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

const Wall: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeamId, selectedTeam } = useTeam();
  const { subscribeToChatThreads, updateChatThread, addChatMessage } = useFirestore() as any;
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [posts, setPosts] = useState<WallPost[]>([]);
  const [loading, setLoading] = useState(true);
  const canUnpin = userData ? (isCoach(userData.role) || (userData as any).isClubAdmin) : false;
  // Coaches + club admins post directly to the wall from this page —
  // no detour through chat. Under the hood we write a ChatMessage to
  // the team's primary thread + pin it, matching the chat composer's
  // "Post to wall" toggle path so it shows up identically everywhere.
  const canPost = canUnpin;
  const [composer, setComposer] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [composerAttachments, setComposerAttachments] = useState<Array<{ url: string; name: string; type: string }>>([]);
  const [uploading, setUploading] = useState(false);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState(false);

  // Auto-grow the textarea so a long post isn't constrained to a tiny
  // scroll box. Capped at ~70vh so the toolbar stays in view.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = Math.round(window.innerHeight * 0.7);
    el.style.height = Math.min(el.scrollHeight, max) + 'px';
  }, [composer, previewMode]);

  // Wrap the current selection in textarea with prefix/suffix, or
  // insert at caret when nothing is selected. Restores focus after.
  const wrapSelection = (prefix: string, suffix: string = prefix) => {
    const el = composerRef.current;
    if (!el) return;
    const start = el.selectionStart ?? composer.length;
    const end = el.selectionEnd ?? composer.length;
    const before = composer.slice(0, start);
    const sel = composer.slice(start, end);
    const after = composer.slice(end);
    const placeholder = sel || 'text';
    const next = `${before}${prefix}${placeholder}${suffix}${after}`;
    setComposer(next);
    requestAnimationFrame(() => {
      el.focus();
      const newPos = start + prefix.length + placeholder.length;
      el.setSelectionRange(start + prefix.length, newPos);
    });
  };

  // Insert a block-level prefix at the start of the current line (or
  // selection). Used for bullets, numbered items, headings, blockquotes
  // — anything that lives at the start of a line.
  const insertLinePrefix = (prefix: string) => {
    const el = composerRef.current;
    if (!el) return;
    const start = el.selectionStart ?? composer.length;
    const before = composer.slice(0, start);
    const after = composer.slice(start);
    const needsBreak = before.length > 0 && !before.endsWith('\n');
    const insert = `${needsBreak ? '\n' : ''}${prefix}`;
    const next = `${before}${insert}${after}`;
    setComposer(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + insert.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const insertHr = () => {
    const el = composerRef.current;
    if (!el) return;
    const start = el.selectionStart ?? composer.length;
    const before = composer.slice(0, start);
    const after = composer.slice(start);
    const needsBreak = before.length > 0 && !before.endsWith('\n');
    const insert = `${needsBreak ? '\n' : ''}---\n`;
    setComposer(`${before}${insert}${after}`);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + insert.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const insertLink = () => {
    const url = window.prompt('Link URL:', 'https://');
    if (!url || !url.trim()) return;
    wrapSelection('[', `](${url.trim()})`);
  };

  // Subscribe to the team's chat threads so we always have current
  // pinnedMessageIds. The wall is just a different projection of the
  // same data the chat tab serves.
  useEffect(() => {
    if (!selectedTeamId) { setThreads([]); setLoading(false); return; }
    const unsub = subscribeToChatThreads(selectedTeamId, (data) => {
      setThreads(data as ChatThread[]);
    });
    return () => { unsub && unsub(); };
  }, [selectedTeamId, subscribeToChatThreads]);

  // Fetch chat_messages docs for every pinned id across the team's
  // threads. Chunked by 30 to stay under Firestore's "in" cap.
  useEffect(() => {
    if (!selectedTeamId) return;
    const idToThread = new Map<string, { id: string; title: string }>();
    for (const t of threads) {
      const ids: string[] = ((t as any).pinnedMessageIds || []) as string[];
      for (const id of ids) {
        if (id && !idToThread.has(id)) idToThread.set(id, { id: t.id, title: t.title || 'Chat' });
      }
    }
    if (idToThread.size === 0) { setPosts([]); setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const { collection, getDocs, query, where, documentId } = await import('firebase/firestore');
        const { db } = await import('../utils/firebase');
        const ids = Array.from(idToThread.keys());
        const fetched: any[] = [];
        for (let i = 0; i < ids.length; i += 30) {
          const slice = ids.slice(i, i + 30);
          const snap = await getDocs(query(
            collection(db, 'chat_messages'),
            where(documentId(), 'in', slice),
          ));
          snap.docs.forEach(d => fetched.push({ id: d.id, ...(d.data() as any) }));
        }
        if (cancelled) return;
        const next = fetched
          .filter(m => m.content || (Array.isArray(m.attachments) && m.attachments.length > 0))
          .map(m => {
            const tr = idToThread.get(m.id) || { id: m.threadId || '', title: 'Chat' };
            return {
              id: m.id,
              threadId: tr.id,
              threadTitle: tr.title,
              content: (m.content as string) || '',
              senderId: m.senderId,
              senderName: m.senderName as string,
              senderRole: m.senderRole as string | undefined,
              timestamp: m.timestamp?.toDate?.() || new Date(m.timestamp || Date.now()),
              attachments: m.attachments,
              reactions: Array.isArray(m.reactions) ? m.reactions : [],
              wallPinnedTop: typeof m.wallPinnedTop === 'number' ? m.wallPinnedTop : null,
            } as WallPost;
          })
          // Pinned-to-top posts go first, ordered by most-recently
          // pinned. Then everything else by post timestamp desc.
          .sort((a, b) => {
            const aTop = a.wallPinnedTop || 0;
            const bTop = b.wallPinnedTop || 0;
            if (aTop !== bTop) return bTop - aTop;
            return b.timestamp.getTime() - a.timestamp.getTime();
          });
        setPosts(next);
        setLoading(false);
      } catch (err) {
        console.warn('wall load failed', err);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedTeamId, threads]);

  const unpin = async (post: WallPost) => {
    if (!canUnpin) return;
    if (!window.confirm('Remove this from the wall? The original message stays in chat.')) return;
    const thread = threads.find(t => t.id === post.threadId);
    if (!thread) return;
    const current = ((thread as any).pinnedMessageIds || []) as string[];
    const next = current.filter(id => id !== post.id);
    try {
      await updateChatThread(thread.id, { pinnedMessageIds: next } as any);
      setPosts(prev => prev.filter(p => p.id !== post.id));
    } catch (err) {
      console.error('unpin failed', err);
      alert('Failed to unpin — try again.');
    }
  };

  // Post directly to the wall. Picks the team's primary chat thread
  // (preferring a non-DM, non-private team-scoped one), writes a new
  // ChatMessage, and pins it. Same data path as the chat composer's
  // "Post to wall" toggle.
  const handlePost = async () => {
    const content = composer.trim();
    if (!content || !userData || !selectedTeamId || posting) return;
    setPosting(true);
    setPostError(null);
    try {
      // Pick the best thread to post into. Preference order:
      //   1. A non-DM, non-private thread on this team with most recent activity
      //   2. The first team-scoped thread we find
      const teamThreads = threads.filter(t => !t.isDM && !t.isPrivate && t.teamId === selectedTeamId);
      const target = teamThreads.sort((a, b) => {
        const aTs = (a.lastActivity as any)?.toDate?.()?.getTime?.() || new Date(a.lastActivity || 0).getTime();
        const bTs = (b.lastActivity as any)?.toDate?.()?.getTime?.() || new Date(b.lastActivity || 0).getTime();
        return bTs - aTs;
      })[0];
      if (!target) {
        setPostError("No team chat thread to post into yet — create one in Chat first.");
        return;
      }
      const messageId = await addChatMessage({
        threadId: target.id,
        teamId: selectedTeamId,
        content,
        senderId: userData.uid,
        senderName: userData.name || 'Coach',
        senderRole: isCoach(userData.role) || (userData as any).isClubAdmin ? 'coach' : 'parent',
        timestamp: new Date(),
        attachments: composerAttachments.length > 0 ? composerAttachments : undefined,
      });
      // Pin it so it shows up on the wall immediately.
      const existing = Array.isArray(target.pinnedMessageIds) ? target.pinnedMessageIds : [];
      await updateChatThread(target.id, {
        pinnedMessageIds: [...existing, messageId],
      } as any);
      setComposer('');
      setComposerAttachments([]);
    } catch (err: any) {
      console.error('wall post failed', err);
      setPostError(err?.message || 'Post failed — try again.');
    } finally {
      setPosting(false);
    }
  };

  // Pin / unpin a post at the top of the wall. Stored directly on the
  // ChatMessage so it survives across clients that already have the
  // Wall feature — they'll read the field even if their build predates
  // the pin-to-top action.
  const togglePinTop = async (post: WallPost) => {
    if (!canUnpin) return;
    try {
      const wasPinned = !!post.wallPinnedTop;
      await updateDoc(doc(db, 'chat_messages', post.id), {
        wallPinnedTop: wasPinned ? null : Date.now(),
      });
      setPosts(prev => prev
        .map(p => p.id === post.id ? { ...p, wallPinnedTop: wasPinned ? null : Date.now() } : p)
        .sort((a, b) => {
          const aTop = a.wallPinnedTop || 0;
          const bTop = b.wallPinnedTop || 0;
          if (aTop !== bTop) return bTop - aTop;
          return b.timestamp.getTime() - a.timestamp.getTime();
        })
      );
    } catch (err) {
      console.error('pin-to-top failed', err);
      alert('Failed to update pin — try again.');
    }
  };

  // Like / unlike a wall post. Uses the existing reactions array with
  // a 'heart' emoji so the same row counts as a chat reaction too —
  // people reading the same message in chat see your like there too.
  const toggleLike = async (post: WallPost) => {
    if (!userData?.uid) return;
    const reactions = post.reactions || [];
    const mine = reactions.find(r => r.userId === userData.uid && r.emoji === '❤️');
    const next = mine
      ? reactions.filter(r => !(r.userId === userData.uid && r.emoji === '❤️'))
      : [...reactions, { emoji: '❤️', userId: userData.uid, userName: userData.name || 'Friend' }];
    setPosts(prev => prev.map(p => p.id === post.id ? { ...p, reactions: next } : p));
    try {
      await updateDoc(doc(db, 'chat_messages', post.id), { reactions: next });
    } catch (err) {
      console.error('like toggle failed', err);
      // Revert on failure.
      setPosts(prev => prev.map(p => p.id === post.id ? { ...p, reactions } : p));
    }
  };

  // Image upload. Each picked file goes straight to R2 via the
  // existing presign endpoint, and the public URL is stored as an
  // attachment on the post. Existing chat attachment renderer covers
  // display so old wall clients see the images too.
  const handleImageUpload = async (file: File) => {
    if (!file) return;
    setUploading(true);
    setPostError(null);
    try {
      const r = await uploadToR2(file, 'wall_media');
      setComposerAttachments(prev => [
        ...prev,
        { url: r.url, name: file.name, type: file.type || 'image' },
      ]);
    } catch (err: any) {
      console.error('image upload failed', err);
      setPostError(err?.message || 'Image upload failed.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="min-h-screen bg-fire-50">
      <section className="bg-gradient-to-b from-slate-950 to-slate-900 px-4 sm:px-6 py-4 border-b border-cyan-500/10">
        <div className="max-w-3xl mx-auto">
          <Link to="/dashboard" className="inline-flex items-center gap-1.5 text-xs font-bold tracking-widest uppercase text-cyan-300 hover:text-cyan-200 mb-2">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
            Dashboard
          </Link>
          <h1 className="text-2xl sm:text-3xl font-black text-white leading-tight flex items-center gap-2">
            <AppIcon name="news" className="w-6 h-6 text-cyan-300" />
            Team Wall
          </h1>
          <p className="text-sm text-slate-400 mt-0.5">
            {selectedTeam?.name ? `${selectedTeam.name} — ` : ''}announcements, links, and pinned messages
          </p>
        </div>
      </section>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-5 space-y-4">
        {canPost && (
          <div className="bg-white rounded-2xl ring-1 ring-slate-200 shadow-sm overflow-hidden">
            {/* Toolbar — Markdown-style inserts. We use a homegrown
                tiny syntax to avoid pulling in a 200kb rich editor
                dep. Old wall clients render the raw markdown text
                (still readable); new ones render formatted. */}
            <div className="sticky top-0 z-10 bg-white border-b border-slate-100 px-2 py-2 flex items-center gap-0.5 flex-wrap">
              <ToolGroup>
                <ToolbarBtn title="Heading 1" onClick={() => insertLinePrefix('# ')} icon={<H1Icon />} />
                <ToolbarBtn title="Heading 2" onClick={() => insertLinePrefix('## ')} icon={<H2Icon />} />
              </ToolGroup>
              <ToolGroup>
                <ToolbarBtn title="Bold (⌘B)" onClick={() => wrapSelection('**')} icon={<BoldIcon />} />
                <ToolbarBtn title="Italic (⌘I)" onClick={() => wrapSelection('*')} icon={<ItalicIcon />} />
                <ToolbarBtn title="Inline code" onClick={() => wrapSelection('`')} icon={<CodeIcon />} />
              </ToolGroup>
              <ToolGroup>
                <ToolbarBtn title="Bullet list" onClick={() => insertLinePrefix('- ')} icon={<BulletIcon />} />
                <ToolbarBtn title="Numbered list" onClick={() => insertLinePrefix('1. ')} icon={<NumberedIcon />} />
                <ToolbarBtn title="Quote" onClick={() => insertLinePrefix('> ')} icon={<QuoteIcon />} />
                <ToolbarBtn title="Divider" onClick={insertHr} icon={<HrIcon />} />
              </ToolGroup>
              <ToolGroup>
                <ToolbarBtn title="Link" onClick={insertLink} icon={<LinkIcon />} />
                <label className="inline-flex items-center justify-center w-8 h-8 rounded-md text-slate-700 hover:bg-slate-100 cursor-pointer" title="Attach image">
                  {uploading ? <SpinnerIcon /> : <ImageIcon />}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    disabled={uploading}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handleImageUpload(f);
                      e.target.value = '';
                    }}
                  />
                </label>
              </ToolGroup>
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => setPreviewMode(v => !v)}
                className={`inline-flex items-center gap-1.5 px-2.5 h-8 rounded-md text-[11px] font-extrabold uppercase tracking-widest transition ${
                  previewMode
                    ? 'bg-cyan-50 text-cyan-700 ring-1 ring-cyan-200'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
                title={previewMode ? 'Back to edit' : 'Preview'}
              >
                {previewMode ? <EditIcon /> : <EyeIcon />}
                <span>{previewMode ? 'Edit' : 'Preview'}</span>
              </button>
            </div>

            <div className="px-4 sm:px-6 py-4">
              {previewMode ? (
                <div className="min-h-[160px]">
                  {composer.trim() ? (
                    <article className="prose-wall">
                      <RichContent text={composer} />
                    </article>
                  ) : (
                    <p className="text-sm text-slate-400 italic">Nothing to preview yet — switch back to Edit and start typing.</p>
                  )}
                </div>
              ) : (
                <textarea
                  ref={composerRef}
                  value={composer}
                  onChange={(e) => setComposer(e.target.value)}
                  placeholder="Write a beautiful announcement.&#10;&#10;Use the toolbar above for headings, **bold**, lists, quotes, and links. Long posts welcome — the editor grows with you."
                  rows={6}
                  className="w-full px-0 py-0 border-0 focus:outline-none focus:ring-0 text-[16px] leading-relaxed resize-none placeholder:text-slate-400"
                  style={{ fontSize: '16px', minHeight: '160px' }}
                />
              )}

              {composerAttachments.length > 0 && (
                <div className={`mt-4 grid gap-2 ${composerAttachments.length === 1 ? 'grid-cols-1' : 'grid-cols-3'}`}>
                  {composerAttachments.map((a, i) => (
                    <div key={i} className={`relative rounded-xl overflow-hidden ring-1 ring-slate-200 bg-slate-50 ${
                      composerAttachments.length === 1 ? 'aspect-[16/9]' : 'aspect-square'
                    }`}>
                      <img src={a.url} alt={a.name} className="w-full h-full object-cover" />
                      <button
                        type="button"
                        onClick={() => setComposerAttachments(prev => prev.filter((_, idx) => idx !== i))}
                        className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80"
                        title="Remove"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {postError && (
                <div className="mt-3 rounded-lg bg-rose-50 ring-1 ring-rose-200 px-3 py-2 text-[12px] text-rose-700">
                  {postError}
                </div>
              )}
            </div>

            <div className="px-4 sm:px-6 py-3 border-t border-slate-100 bg-slate-50/50 flex items-center justify-between gap-3">
              <span className="text-[11px] text-slate-500 hidden sm:inline">
                Posts to the team's main chat thread and pins it here.
              </span>
              <span className="text-[11px] text-slate-500 sm:hidden">
                {composer.length > 0 ? `${composer.length} chars` : 'Markdown supported'}
              </span>
              <button
                type="button"
                onClick={handlePost}
                disabled={(!composer.trim() && composerAttachments.length === 0) || posting}
                className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-extrabold uppercase tracking-widest disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {posting ? 'Posting…' : 'Post to wall'}
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="text-center py-16 text-slate-400 text-sm">Loading…</div>
        ) : posts.length === 0 ? (
          <div className="bg-white rounded-2xl ring-1 ring-slate-200 p-8 text-center">
            <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-cyan-50 ring-1 ring-cyan-200 flex items-center justify-center">
              <AppIcon name="news" className="w-5 h-5 text-cyan-600" />
            </div>
            <p className="text-sm font-semibold text-slate-700 mb-1">Nothing on the wall yet.</p>
            <p className="text-xs text-slate-500 max-w-xs mx-auto">
              {canPost
                ? 'Type your first announcement above. You can also pin any existing chat message via the ⋯ menu.'
                : 'Coaches post announcements and important links here.'}
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {posts.map(p => {
              const myUid = userData?.uid;
              const likes = (p.reactions || []).filter(r => r.emoji === '❤️');
              const myLike = myUid ? likes.some(r => r.userId === myUid) : false;
              const isPinnedTop = !!p.wallPinnedTop;
              return (
                <li
                  key={p.id}
                  className={`bg-white rounded-2xl overflow-hidden ${
                    isPinnedTop ? 'ring-2 ring-amber-300' : 'ring-1 ring-slate-200'
                  }`}
                >
                  {isPinnedTop && (
                    <div className="px-4 py-1 bg-amber-50 border-b border-amber-200 flex items-center gap-1.5">
                      <svg className="w-3 h-3 text-amber-700" fill="currentColor" viewBox="0 0 24 24"><path d="M16 12l4-4-8-8-4 4 8 8zm-8 4l4-4-4-4-4 4 4 4z"/></svg>
                      <span className="text-[10px] font-extrabold uppercase tracking-widest text-amber-800">Pinned</span>
                    </div>
                  )}
                  <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
                    <span className="text-sm font-bold text-slate-900">{p.senderName}</span>
                    {p.senderRole === 'coach' && (
                      <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-700 bg-cyan-50 ring-1 ring-cyan-200 px-1.5 py-0.5 rounded">Coach</span>
                    )}
                    <span className="text-[11px] text-slate-400 ml-auto">
                      {p.timestamp.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </span>
                  </div>
                  <article className="px-4 sm:px-6 py-4 text-slate-800 break-words">
                    <RichContent text={p.content} />
                  </article>
                  {p.attachments && p.attachments.length > 0 && (
                    p.attachments.length === 1 ? (
                      <div className="px-4 sm:px-6 pb-4">
                        <img
                          src={p.attachments[0].url}
                          alt={p.attachments[0].name || 'attachment'}
                          loading="lazy"
                          className="rounded-xl object-cover w-full max-h-[480px] ring-1 ring-slate-200"
                          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                        />
                      </div>
                    ) : (
                      <div className="px-4 sm:px-6 pb-4 grid grid-cols-2 gap-1.5">
                        {p.attachments.slice(0, 4).map((a, i) => (
                          <img
                            key={i}
                            src={a.url}
                            alt={a.name || 'attachment'}
                            loading="lazy"
                            className="rounded-lg object-cover w-full h-40 ring-1 ring-slate-200"
                            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                          />
                        ))}
                      </div>
                    )
                  )}
                  <div className="px-4 py-2 border-t border-slate-100 flex items-center gap-1 flex-wrap bg-slate-50">
                    <button
                      type="button"
                      onClick={() => toggleLike(p)}
                      className={`text-xs font-bold tracking-widest uppercase flex items-center gap-1 px-2 py-1 rounded transition ${
                        myLike ? 'text-rose-600' : 'text-slate-500 hover:text-rose-600'
                      }`}
                      title={myLike ? 'Unlike' : 'Like'}
                    >
                      <span className={myLike ? 'inline-block scale-110' : ''}>{myLike ? '❤️' : '🤍'}</span>
                      {likes.length > 0 && <span>{likes.length}</span>}
                    </button>
                    <Link
                      to={`/chat?thread=${encodeURIComponent(p.threadId)}&message=${encodeURIComponent(p.id)}`}
                      className="text-xs font-bold tracking-widest uppercase text-cyan-700 hover:text-cyan-900 px-2 py-1"
                    >
                      Open in chat
                    </Link>
                    <div className="flex-1" />
                    {canUnpin && (
                      <>
                        <button
                          type="button"
                          onClick={() => togglePinTop(p)}
                          className={`text-xs font-bold tracking-widest uppercase px-2 py-1 rounded ${
                            isPinnedTop ? 'text-amber-700 hover:text-amber-900' : 'text-slate-500 hover:text-amber-700'
                          }`}
                          title={isPinnedTop ? 'Unpin from top' : 'Pin to top'}
                        >
                          {isPinnedTop ? 'Unpin' : 'Pin top'}
                        </button>
                        <button
                          onClick={() => unpin(p)}
                          className="text-xs font-bold tracking-widest uppercase text-rose-600 hover:text-rose-800 px-2 py-1"
                          title="Remove from wall (original message stays in chat)"
                        >
                          Remove
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};

// ── Toolbar building blocks ────────────────────────────────────

const ToolGroup: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="inline-flex items-center border-r border-slate-200 last:border-r-0 pr-1 mr-1 last:pr-0 last:mr-0">
    {children}
  </div>
);

const ToolbarBtn: React.FC<{ title: string; onClick: () => void; icon: React.ReactNode }> = ({ title, onClick, icon }) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    aria-label={title}
    className="inline-flex items-center justify-center w-8 h-8 rounded-md text-slate-700 hover:bg-slate-100 active:bg-slate-200 transition"
  >
    {icon}
  </button>
);

// ── Toolbar icons (monoline SVG, no emoji per brand guidance) ──

const BoldIcon: React.FC = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" /><path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" />
  </svg>
);
const ItalicIcon: React.FC = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <line x1="19" y1="4" x2="10" y2="4" /><line x1="14" y1="20" x2="5" y2="20" /><line x1="15" y1="4" x2="9" y2="20" />
  </svg>
);
const CodeIcon: React.FC = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
  </svg>
);
const H1Icon: React.FC = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <path d="M4 6v12M12 6v12M4 12h8" /><path d="M17 10l3-1v9" />
  </svg>
);
const H2Icon: React.FC = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <path d="M4 6v12M12 6v12M4 12h8" /><path d="M16 11a2 2 0 1 1 4 0c0 1.5-4 2.5-4 6h4" />
  </svg>
);
const BulletIcon: React.FC = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <line x1="9" y1="6" x2="20" y2="6" /><line x1="9" y1="12" x2="20" y2="12" /><line x1="9" y1="18" x2="20" y2="18" />
    <circle cx="4" cy="6" r="1.5" fill="currentColor" /><circle cx="4" cy="12" r="1.5" fill="currentColor" /><circle cx="4" cy="18" r="1.5" fill="currentColor" />
  </svg>
);
const NumberedIcon: React.FC = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <line x1="10" y1="6" x2="21" y2="6" /><line x1="10" y1="12" x2="21" y2="12" /><line x1="10" y1="18" x2="21" y2="18" />
    <path d="M4 6h1v4" /><path d="M3 18a1.5 1.5 0 0 1 3 0c0 1-3 2-3 3h3" />
  </svg>
);
const QuoteIcon: React.FC = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <path d="M3 21c3 0 7-1 7-8V5H4v7h3c0 4-1 5-4 5z" /><path d="M14 21c3 0 7-1 7-8V5h-6v7h3c0 4-1 5-4 5z" />
  </svg>
);
const HrIcon: React.FC = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <line x1="3" y1="12" x2="21" y2="12" />
  </svg>
);
const LinkIcon: React.FC = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </svg>
);
const ImageIcon: React.FC = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
  </svg>
);
const EyeIcon: React.FC = () => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
  </svg>
);
const EditIcon: React.FC = () => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
  </svg>
);
const SpinnerIcon: React.FC = () => (
  <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);

// ── Markdown-ish renderer ──────────────────────────────────────
// Supports: headings (#, ##, ###), bold (**x**), italic (*x*), inline
// code (`x`), bullets (- or • or *), numbered lists (1. 2. 3.),
// blockquotes (> ), horizontal rules (---), bare URLs + [text](url).
// Old clients without this renderer fall back to raw text — still
// readable, just not styled.

const RichContent: React.FC<{ text: string }> = ({ text }) => {
  const lines = text.split('\n');
  const blocks: React.ReactNode[] = [];
  let bulletBuffer: string[] = [];
  let orderedBuffer: string[] = [];
  let quoteBuffer: string[] = [];

  const flushBullets = (keyPrefix: string) => {
    if (bulletBuffer.length === 0) return;
    const items = bulletBuffer.slice();
    bulletBuffer = [];
    blocks.push(
      <ul key={keyPrefix} className="list-disc pl-6 my-3 space-y-1.5 marker:text-cyan-500">
        {items.map((b, i) => <li key={i} className="pl-1">{renderInline(b)}</li>)}
      </ul>
    );
  };
  const flushOrdered = (keyPrefix: string) => {
    if (orderedBuffer.length === 0) return;
    const items = orderedBuffer.slice();
    orderedBuffer = [];
    blocks.push(
      <ol key={keyPrefix} className="list-decimal pl-6 my-3 space-y-1.5 marker:text-cyan-500 marker:font-bold">
        {items.map((b, i) => <li key={i} className="pl-1">{renderInline(b)}</li>)}
      </ol>
    );
  };
  const flushQuote = (keyPrefix: string) => {
    if (quoteBuffer.length === 0) return;
    const text = quoteBuffer.join('\n');
    quoteBuffer = [];
    blocks.push(
      <blockquote key={keyPrefix} className="my-4 pl-4 border-l-4 border-cyan-300 text-slate-600 italic whitespace-pre-wrap">
        {renderInline(text)}
      </blockquote>
    );
  };
  const flushAll = (k: string) => { flushBullets(`${k}-ul`); flushOrdered(`${k}-ol`); flushQuote(`${k}-q`); };

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    // Horizontal rule
    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      flushAll(`hr-${i}`);
      blocks.push(<hr key={`hr-${i}`} className="my-5 border-t border-slate-200" />);
      return;
    }
    // Headings
    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      flushAll(`h-${i}`);
      const level = headingMatch[1].length;
      const inner = renderInline(headingMatch[2]);
      if (level === 1) blocks.push(<h2 key={`h-${i}`} className="text-2xl sm:text-3xl font-black text-slate-900 leading-tight mt-5 mb-3 first:mt-0">{inner}</h2>);
      else if (level === 2) blocks.push(<h3 key={`h-${i}`} className="text-xl sm:text-2xl font-extrabold text-slate-900 leading-snug mt-5 mb-2 first:mt-0">{inner}</h3>);
      else blocks.push(<h4 key={`h-${i}`} className="text-base sm:text-lg font-extrabold text-slate-900 uppercase tracking-wide mt-4 mb-2 first:mt-0">{inner}</h4>);
      return;
    }
    // Blockquote
    if (trimmed.startsWith('> ')) {
      flushBullets(`bq-ul-${i}`); flushOrdered(`bq-ol-${i}`);
      quoteBuffer.push(trimmed.slice(2));
      return;
    }
    // Bullets
    if (/^[•\-*]\s+/.test(trimmed)) {
      flushOrdered(`bu-ol-${i}`); flushQuote(`bu-q-${i}`);
      bulletBuffer.push(trimmed.replace(/^[•\-*]\s+/, ''));
      return;
    }
    // Numbered
    if (/^\d+\.\s+/.test(trimmed)) {
      flushBullets(`no-ul-${i}`); flushQuote(`no-q-${i}`);
      orderedBuffer.push(trimmed.replace(/^\d+\.\s+/, ''));
      return;
    }
    // Paragraph or blank line
    flushAll(`p-${i}`);
    if (trimmed) {
      blocks.push(<p key={`p-${i}`} className="my-3 whitespace-pre-wrap leading-relaxed first:mt-0">{renderInline(line)}</p>);
    } else {
      blocks.push(<div key={`br-${i}`} className="h-1" />);
    }
  });
  flushAll('final');
  return <>{blocks}</>;
};

// Inline pass — handle **bold**, *italic*, `code`, [label](url) and
// bare URLs in one walk. Order matters: nested patterns are parsed
// left-to-right with the longest match winning.
function renderInline(text: string): React.ReactNode {
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    // [label](url) link
    const linkMatch = text.slice(i).match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/);
    if (linkMatch) {
      out.push(
        <a key={key++} href={linkMatch[2]} target="_blank" rel="noopener noreferrer" className="text-cyan-600 underline">
          {linkMatch[1]}
        </a>
      );
      i += linkMatch[0].length;
      continue;
    }
    // **bold**
    if (text.slice(i, i + 2) === '**') {
      const end = text.indexOf('**', i + 2);
      if (end !== -1) {
        out.push(<strong key={key++} className="font-extrabold">{renderInline(text.slice(i + 2, end))}</strong>);
        i = end + 2;
        continue;
      }
    }
    // *italic*  (only if not part of ** — already handled above)
    if (text[i] === '*' && text[i + 1] !== '*') {
      const end = text.indexOf('*', i + 1);
      if (end !== -1 && text[end + 1] !== '*') {
        out.push(<em key={key++}>{renderInline(text.slice(i + 1, end))}</em>);
        i = end + 1;
        continue;
      }
    }
    // `code`
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) {
        out.push(<code key={key++} className="px-1 py-0.5 rounded bg-slate-100 text-[13px] font-mono">{text.slice(i + 1, end)}</code>);
        i = end + 1;
        continue;
      }
    }
    // Bare URL
    const urlMatch = text.slice(i).match(/^(https?:\/\/[^\s]+)/);
    if (urlMatch) {
      out.push(
        <a key={key++} href={urlMatch[1]} target="_blank" rel="noopener noreferrer" className="text-cyan-600 underline break-all">
          {urlMatch[1]}
        </a>
      );
      i += urlMatch[0].length;
      continue;
    }
    // Plain text — accumulate until next special char.
    const nextSpecial = (() => {
      let n = i + 1;
      while (n < text.length) {
        const ch = text[n];
        if (ch === '*' || ch === '`' || ch === '[' || ch === 'h') {
          if (ch === 'h') {
            if (text.slice(n, n + 7) === 'http://' || text.slice(n, n + 8) === 'https://') return n;
          } else {
            return n;
          }
        }
        n++;
      }
      return text.length;
    })();
    out.push(text.slice(i, nextSpecial));
    i = nextSpecial;
  }
  return <>{out}</>;
}

export default Wall;
