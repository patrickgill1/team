import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { addDoc, collection, deleteDoc, doc, onSnapshot, orderBy, query, updateDoc, where } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../contexts/AuthContext';
import { useTeam } from '../contexts/TeamContext';
import { isCoach } from '../utils/helpers';
import { uploadToR2 } from '../utils/r2Upload';
import AppIcon from '../components/common/AppIcon';
import EmptyState from '../components/common/EmptyState';
import { SkeletonCard } from '../components/common/Skeleton';
import type { WallPost, WallComment } from '../types';

const draftKey = (teamId: string | null) => `wall.draft.${teamId || 'unknown'}`;

// Strip markdown for the push preview body — readers see plain text
// in the OS notification, not literal ## or ** characters.
function stripMarkdownForPush(md: string, maxLen = 140): string {
  let s = md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')      // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')   // links → label
    .replace(/^#{1,6}\s+/gm, '')               // headings
    .replace(/^>\s+/gm, '')                    // blockquotes
    .replace(/^[-*•]\s+/gm, '• ')              // bullets normalize
    .replace(/^\d+\.\s+/gm, '')                // numbered
    .replace(/^---+$/gm, '')                   // hr
    .replace(/`([^`]+)`/g, '$1')               // inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1')         // bold
    .replace(/\*([^*]+)\*/g, '$1')             // italic
    .replace(/\n{2,}/g, ' · ')                 // paragraph break → middot
    .replace(/\n/g, ' ')
    .trim();
  if (s.length > maxLen) s = s.slice(0, maxLen - 1).trimEnd() + '…';
  return s;
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
  const [posts, setPosts] = useState<WallPost[]>([]);
  const [loading, setLoading] = useState(true);
  const canManage = userData ? (isCoach(userData.role) || (userData as any).isClubAdmin) : false;
  // Coaches + club admins author wall posts. The wall is its own
  // collection now (wall_posts) — completely independent from chat.
  // Markdown source lives here, never leaks into a chat thread.
  const canPost = canManage;
  const [composer, setComposer] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [composerAttachments, setComposerAttachments] = useState<Array<{ url: string; name: string; type: string }>>([]);
  const [uploading, setUploading] = useState(false);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState(false);
  const [draftStatus, setDraftStatus] = useState<'idle' | 'saved'>('idle');
  // Per-post comment state: which posts are expanded, and what the
  // current comment composer says. Comments themselves live in their
  // own subscription map.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const [comments, setComments] = useState<Record<string, WallComment[]>>({});
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({});

  // Category filter — drives the pill row above the feed and the
  // composer's category chooser. 'all' shows everything.
  type WallCategory = NonNullable<WallPost['category']>;
  const CATEGORIES: Array<{ id: WallCategory | 'all'; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'announcement', label: 'News' },
    { id: 'result', label: 'Results' },
    { id: 'spotlight', label: 'Spotlight' },
    { id: 'practice', label: 'Practice' },
  ];
  const CATEGORY_TONE: Record<WallCategory, { text: string; bg: string; ring: string }> = {
    announcement: { text: 'text-cyan-800', bg: 'bg-cyan-50', ring: 'ring-cyan-200' },
    result: { text: 'text-emerald-800', bg: 'bg-emerald-50', ring: 'ring-emerald-200' },
    spotlight: { text: 'text-amber-800', bg: 'bg-amber-50', ring: 'ring-amber-200' },
    practice: { text: 'text-violet-800', bg: 'bg-violet-50', ring: 'ring-violet-200' },
    system: { text: 'text-slate-700', bg: 'bg-slate-100', ring: 'ring-slate-200' },
  };
  const CATEGORY_LABEL: Record<WallCategory, string> = {
    announcement: 'News',
    result: 'Result',
    spotlight: 'Spotlight',
    practice: 'Practice',
    system: 'Auto',
  };
  const [activeCategory, setActiveCategory] = useState<WallCategory | 'all'>('all');
  const [composerCategory, setComposerCategory] = useState<WallCategory>('announcement');
  // The composer used to live at the top of the feed and Patrick had
  // to scroll past it every time. It now opens from a floating +
  // button, the way Instagram / Facebook do new-post creation.
  const [composerOpen, setComposerOpen] = useState(false);

  // Auto-grow the textarea so a long post isn't constrained to a tiny
  // scroll box. Capped at ~70vh so the toolbar stays in view.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = Math.round(window.innerHeight * 0.7);
    el.style.height = Math.min(el.scrollHeight, max) + 'px';
  }, [composer, previewMode]);

  // Restore draft when switching teams.
  useEffect(() => {
    if (!selectedTeamId) return;
    try {
      const raw = localStorage.getItem(draftKey(selectedTeamId));
      if (raw) {
        const data = JSON.parse(raw);
        if (data?.composer) setComposer(data.composer);
      }
    } catch { /* ignore */ }
  }, [selectedTeamId]);

  // Autosave the draft (debounced).
  useEffect(() => {
    if (!selectedTeamId) return;
    const id = setTimeout(() => {
      try {
        if (composer.trim()) {
          localStorage.setItem(draftKey(selectedTeamId), JSON.stringify({ composer, savedAt: Date.now() }));
          setDraftStatus('saved');
        } else {
          localStorage.removeItem(draftKey(selectedTeamId));
          setDraftStatus('idle');
        }
      } catch { /* ignore quota */ }
    }, 500);
    return () => clearTimeout(id);
  }, [composer, selectedTeamId]);

  const discardDraft = () => {
    if (!selectedTeamId) return;
    if (!composer.trim()) return;
    if (!window.confirm('Discard this draft?')) return;
    setComposer('');
    setComposerAttachments([]);
    try { localStorage.removeItem(draftKey(selectedTeamId)); } catch { /* ignore */ }
    setDraftStatus('idle');
  };

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

  // Subscribe to wall_posts for this team. The wall is its own
  // collection — no longer a projection of chat. Most-recently pinned
  // posts sort first, then everything else by timestamp desc.
  useEffect(() => {
    if (!selectedTeamId) { setPosts([]); setLoading(false); return; }
    setLoading(true);
    const q = query(
      collection(db, 'wall_posts'),
      where('teamId', '==', selectedTeamId),
      orderBy('timestamp', 'desc'),
    );
    const unsub = onSnapshot(q, (snap) => {
      const next: WallPost[] = snap.docs.map(d => {
        const data = d.data() as any;
        return {
          id: d.id,
          teamId: data.teamId,
          content: data.content || '',
          senderId: data.senderId,
          senderName: data.senderName || 'Coach',
          senderRole: data.senderRole,
          timestamp: data.timestamp?.toDate?.() || new Date(data.timestamp || Date.now()),
          attachments: Array.isArray(data.attachments) ? data.attachments : undefined,
          reactions: Array.isArray(data.reactions) ? data.reactions : [],
          wallPinnedTop: typeof data.wallPinnedTop === 'number' ? data.wallPinnedTop : null,
          postedFrom: data.postedFrom,
          category: data.category || 'announcement',
        };
      }).sort((a, b) => {
        const aTop = a.wallPinnedTop || 0;
        const bTop = b.wallPinnedTop || 0;
        if (aTop !== bTop) return bTop - aTop;
        return b.timestamp.getTime() - a.timestamp.getTime();
      });
      setPosts(next);
      setLoading(false);
    }, (err) => {
      console.warn('wall subscribe failed', err);
      setLoading(false);
    });
    return () => unsub();
  }, [selectedTeamId]);

  // Subscribe to comment COUNTS for every loaded post (lightweight,
  // one onSnapshot per post). For posts the user has expanded, also
  // store the full comment list. The count subscription only reads
  // the latest 50 — enough for the badge and the open view.
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    for (const p of posts) {
      const q = query(
        collection(db, 'wall_comments'),
        where('postId', '==', p.id),
        orderBy('timestamp', 'asc'),
      );
      const unsub = onSnapshot(q, (snap) => {
        const list: WallComment[] = snap.docs.map(d => {
          const data = d.data() as any;
          return {
            id: d.id,
            postId: data.postId,
            teamId: data.teamId,
            content: data.content || '',
            senderId: data.senderId,
            senderName: data.senderName || 'Friend',
            timestamp: data.timestamp?.toDate?.() || new Date(data.timestamp || Date.now()),
          };
        });
        setCommentCounts(prev => ({ ...prev, [p.id]: list.length }));
        setComments(prev => ({ ...prev, [p.id]: list }));
      });
      unsubs.push(unsub);
    }
    return () => { unsubs.forEach(u => u()); };
  }, [posts]);

  const toggleExpand = (postId: string) => {
    setExpanded(prev => ({ ...prev, [postId]: !prev[postId] }));
  };

  const submitComment = async (postId: string) => {
    if (!userData?.uid || !selectedTeamId) return;
    const text = (commentDrafts[postId] || '').trim();
    if (!text) return;
    setCommentDrafts(prev => ({ ...prev, [postId]: '' }));
    try {
      await addDoc(collection(db, 'wall_comments'), {
        postId,
        teamId: selectedTeamId,
        content: text,
        senderId: userData.uid,
        senderName: userData.name || 'Friend',
        timestamp: new Date(),
      });
    } catch (err) {
      console.error('comment add failed', err);
      setCommentDrafts(prev => ({ ...prev, [postId]: text }));
    }
  };

  const deleteComment = async (c: WallComment) => {
    if (!userData?.uid) return;
    if (c.senderId !== userData.uid && !canManage) return;
    if (!window.confirm('Delete this comment?')) return;
    try {
      await deleteDoc(doc(db, 'wall_comments', c.id));
    } catch (err) {
      console.error('comment delete failed', err);
    }
  };

  // Delete a post from the wall. No more "unpin" since posts no
  // longer live in chat — removing from the wall means deleting the
  // wall_posts doc outright.
  const removePost = async (post: WallPost) => {
    if (!canManage) return;
    if (!window.confirm('Delete this post? This cannot be undone.')) return;
    try {
      await deleteDoc(doc(db, 'wall_posts', post.id));
    } catch (err) {
      console.error('wall delete failed', err);
      alert('Failed to delete — try again.');
    }
  };

  // Post a new wall_posts doc. No chat involvement.
  const handlePost = async () => {
    const content = composer.trim();
    if ((!content && composerAttachments.length === 0) || !userData || !selectedTeamId || posting) return;
    setPosting(true);
    setPostError(null);
    try {
      await addDoc(collection(db, 'wall_posts'), {
        teamId: selectedTeamId,
        content,
        senderId: userData.uid,
        senderName: userData.name || 'Coach',
        senderRole: isCoach(userData.role) || (userData as any).isClubAdmin ? 'coach' : 'parent',
        timestamp: new Date(),
        attachments: composerAttachments.length > 0 ? composerAttachments : null,
        reactions: [],
        wallPinnedTop: null,
        postedFrom: 'wall',
        isPublic: false,
        category: composerCategory,
      });
      setComposer('');
      setComposerAttachments([]);
      setComposerCategory('announcement');
      setPreviewMode(false);
      try { localStorage.removeItem(draftKey(selectedTeamId)); } catch { /* ignore */ }
      setDraftStatus('idle');
      // Fire-and-forget push to everyone on the team (except the
      // poster). Failures are silent so a flaky push tier never
      // surfaces an error on a successful post.
      try {
        const { sendPushToTeam } = await import('../utils/notify');
        void sendPushToTeam(
          selectedTeamId,
          {
            title: `${userData.name || 'Coach'} posted on the wall`,
            body: stripMarkdownForPush(content) || 'New announcement',
            url: '/wall',
          },
          { excludeUid: userData.uid },
        );
      } catch (e) { console.warn('wall push failed', e); }
    } catch (err: any) {
      console.error('wall post failed', err);
      setPostError(err?.message || 'Post failed — try again.');
    } finally {
      setPosting(false);
    }
  };

  // Toggle a post's public-share visibility AND copy the share link.
  // First click: makes the post public + copies link. Subsequent clicks
  // copy again (and re-share if it had been turned off).
  const shareToWeb = async (post: WallPost) => {
    if (!canManage) return;
    try {
      const isPublicNow = !!(post as any).isPublic;
      if (!isPublicNow) {
        await updateDoc(doc(db, 'wall_posts', post.id), { isPublic: true });
      }
      const { wallPostShareUrl } = await import('./PublicWallPost');
      const url = wallPostShareUrl(post.id);
      try {
        if ((navigator as any).share) {
          await (navigator as any).share({ title: `${post.senderName} posted`, text: post.content.slice(0, 100), url });
        } else {
          await navigator.clipboard.writeText(url);
          alert(`Public link copied:\n${url}`);
        }
      } catch { /* user cancelled share sheet */ }
    } catch (err) {
      console.error('share toggle failed', err);
      alert('Could not enable sharing — try again.');
    }
  };

  // Pin / unpin to top of the wall.
  const togglePinTop = async (post: WallPost) => {
    if (!canManage) return;
    try {
      const wasPinned = !!post.wallPinnedTop;
      await updateDoc(doc(db, 'wall_posts', post.id), {
        wallPinnedTop: wasPinned ? null : Date.now(),
      });
    } catch (err) {
      console.error('pin-to-top failed', err);
      alert('Failed to update pin — try again.');
    }
  };

  // Like / unlike a wall post.
  const toggleLike = async (post: WallPost) => {
    if (!userData?.uid) return;
    const reactions = post.reactions || [];
    const mine = reactions.find(r => r.userId === userData.uid && r.emoji === '❤️');
    const next = mine
      ? reactions.filter(r => !(r.userId === userData.uid && r.emoji === '❤️'))
      : [...reactions, { emoji: '❤️', userId: userData.uid, userName: userData.name || 'Friend' }];
    setPosts(prev => prev.map(p => p.id === post.id ? { ...p, reactions: next } : p));
    try {
      await updateDoc(doc(db, 'wall_posts', post.id), { reactions: next });
    } catch (err) {
      console.error('like toggle failed', err);
      setPosts(prev => prev.map(p => p.id === post.id ? { ...p, reactions } : p));
    }
  };

  // Image upload — insert inline at the caret as markdown so the image
  // appears in the flow of the post (interleaved with text), not as a
  // separate thumbnail strip below. We drop in a placeholder while the
  // upload runs, then swap to the real URL when it finishes.
  const handleImageUpload = async (file: File) => {
    if (!file) return;
    setUploading(true);
    setPostError(null);
    const el = composerRef.current;
    const placeholder = `![Uploading ${file.name}…]()`;
    const start = el?.selectionStart ?? composer.length;
    const before = composer.slice(0, start);
    const after = composer.slice(start);
    const needsBreak = before.length > 0 && !before.endsWith('\n');
    const withPlaceholder = `${before}${needsBreak ? '\n' : ''}${placeholder}\n${after}`;
    setComposer(withPlaceholder);
    try {
      const r = await uploadToR2(file, 'wall_media');
      const final = `![](${r.url})`;
      setComposer(prev => prev.replace(placeholder, final));
      requestAnimationFrame(() => {
        if (!composerRef.current) return;
        const pos = (before + (needsBreak ? '\n' : '') + final).length;
        composerRef.current.focus();
        composerRef.current.setSelectionRange(pos, pos);
      });
    } catch (err: any) {
      console.error('image upload failed', err);
      setComposer(prev => prev.replace(placeholder, ''));
      setPostError(err?.message || 'Image upload failed.');
    } finally {
      setUploading(false);
    }
  };

  // Filter feed by selected category pill. 'all' falls through; any
  // other tag matches the post's category (defaulting to 'announcement'
  // for older posts that predate the field).
  const filteredPosts = posts.filter(p => {
    if (activeCategory === 'all') return true;
    return (p.category || 'announcement') === activeCategory;
  });

  return (
    <div className="min-h-screen bg-slate-100">
      {/* Compact mobile header — no big hero strip eating screen real
          estate. Title row + pill filter on a single sticky stack. */}
      <section className="bg-slate-950 px-4 sm:px-6 py-3 border-b border-white/5">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <Link to="/dashboard" aria-label="Back" className="inline-flex items-center justify-center w-8 h-8 rounded-full text-cyan-300 hover:bg-white/10">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
          </Link>
          <h1 className="text-base sm:text-lg font-black text-white flex items-center gap-1.5">
            <AppIcon name="news" className="w-4 h-4 text-cyan-300" />
            <span className="tracking-tight">The Wall</span>
          </h1>
          <span className="w-8" aria-hidden />
        </div>
      </section>

      {/* Category pills — horizontally scrollable on mobile, snaps under
          the header. Sticky so they stay accessible as the feed scrolls. */}
      <div className="sticky top-0 z-20 bg-slate-100/95 backdrop-blur-md border-b border-slate-200">
        <div className="max-w-2xl mx-auto px-3 py-2 flex items-center gap-1.5 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {CATEGORIES.map(c => (
            <button
              key={c.id}
              type="button"
              onClick={() => setActiveCategory(c.id)}
              className={`shrink-0 px-3.5 py-1.5 rounded-full text-[12px] font-extrabold uppercase tracking-widest transition ${
                activeCategory === c.id
                  ? 'bg-slate-950 text-white'
                  : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-0 sm:px-4 py-3 space-y-3">
        {canPost && composerOpen && (
          <div
            className="fixed inset-0 z-40 bg-slate-950/80 animate-fade-in flex items-end sm:items-center justify-center sm:p-4"
            onClick={() => setComposerOpen(false)}
          >
            <div
              className="bg-white w-full sm:max-w-2xl rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden animate-sheet-up sm:animate-pop-in"
              style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="bg-gradient-to-b from-slate-950 to-slate-900 px-4 py-3 flex items-center justify-between flex-shrink-0">
                <button
                  type="button"
                  onClick={() => setComposerOpen(false)}
                  className="text-[11px] font-extrabold tracking-widest uppercase text-slate-400 hover:text-white"
                >
                  Cancel
                </button>
                <div className="text-xs font-extrabold tracking-widest uppercase text-cyan-300">New post</div>
                <button
                  type="button"
                  onClick={async () => { await handlePost(); if (!postError) setComposerOpen(false); }}
                  disabled={!composer.trim() || posting}
                  className="text-[11px] font-extrabold tracking-widest uppercase text-cyan-300 hover:text-white disabled:opacity-40"
                >
                  {posting ? 'Posting…' : 'Post'}
                </button>
              </div>
              <div className="flex-1 overflow-y-auto">
            {/* Category chooser — pill row above the toolbar. The
                pill the coach picks here becomes the post's category. */}
            <div className="px-3 pt-3 pb-2 flex items-center gap-1.5 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
              {(['announcement','result','spotlight','practice'] as WallCategory[]).map(cat => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setComposerCategory(cat)}
                  className={`shrink-0 px-3 py-1 rounded-full text-[11px] font-extrabold uppercase tracking-widest transition ${
                    composerCategory === cat
                      ? `${CATEGORY_TONE[cat].bg} ${CATEGORY_TONE[cat].text} ring-1 ${CATEGORY_TONE[cat].ring}`
                      : 'text-slate-500 ring-1 ring-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {CATEGORY_LABEL[cat]}
                </button>
              ))}
            </div>
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

              {postError && (
                <div className="mt-3 rounded-lg bg-rose-50 ring-1 ring-rose-200 px-3 py-2 text-[12px] text-rose-700">
                  {postError}
                </div>
              )}
            </div>

            <div className="px-4 sm:px-6 py-2.5 border-t border-slate-100 bg-slate-50/60 flex items-center gap-3 text-[11px] text-slate-500">
              {draftStatus === 'saved' && composer.trim() && (
                <span className="inline-flex items-center gap-1 text-slate-400">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" /></svg>
                  Draft saved
                </span>
              )}
              {composer.trim() && (
                <button
                  type="button"
                  onClick={discardDraft}
                  className="text-slate-400 hover:text-rose-600 underline underline-offset-2"
                >
                  Discard
                </button>
              )}
            </div>
              </div>
            </div>
          </div>
        )}

        {/* Floating + button — replaces the always-on composer at the
            top of the feed. Tap to open the post composer in a sheet.
            Coach/admin gated. Bottom-right with safe-area awareness. */}
        {canPost && !composerOpen && (
          <button
            type="button"
            onClick={() => setComposerOpen(true)}
            aria-label="New post"
            className="fixed right-4 bg-cyan-600 hover:bg-cyan-500 active:scale-95 text-white rounded-full w-14 h-14 shadow-xl ring-4 ring-white/80 flex items-center justify-center z-30 transition"
            style={{ bottom: 'calc(env(safe-area-inset-bottom) + 1rem)' }}
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2.8} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        )}

        {loading ? (
          <div className="space-y-3">
            <SkeletonCard rows={2} />
            <SkeletonCard rows={3} />
          </div>
        ) : filteredPosts.length === 0 ? (
          <div className="px-4">
            <EmptyState
              icon={<AppIcon name="news" className="w-5 h-5" />}
              title={activeCategory === 'all' ? 'Nothing on the wall yet' : 'No posts in this category'}
              description={activeCategory === 'all'
                ? (canPost
                  ? 'Type your first announcement above. The wall is for formatted posts — chat is separate.'
                  : 'Coaches post announcements and important links here.')
                : 'Try another category, or post one of your own.'}
            />
          </div>
        ) : (
          <ul className="space-y-3">
            {filteredPosts.map(p => {
              const myUid = userData?.uid;
              const likes = (p.reactions || []).filter(r => r.emoji === '❤️');
              const myLike = myUid ? likes.some(r => r.userId === myUid) : false;
              const isPinnedTop = !!p.wallPinnedTop;
              const cat = (p.category || 'announcement') as WallCategory;
              const tone = CATEGORY_TONE[cat];
              const commentsForPost = comments[p.id] || [];
              const previewComments = commentsForPost.slice(-2);
              const hiddenCount = Math.max(0, (commentCounts[p.id] || commentsForPost.length) - previewComments.length);
              return (
                <li
                  key={p.id}
                  className={`bg-white sm:rounded-2xl overflow-hidden shadow-sm ${
                    isPinnedTop ? 'ring-2 ring-amber-300' : 'ring-1 ring-slate-200'
                  }`}
                >
                  {/* Card header — avatar (initial), name + role, time,
                      category pill. Mobile-card design, not a desktop
                      blog post. */}
                  <div className="px-4 pt-3.5 pb-3 flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center font-extrabold text-[15px] shrink-0 ${
                      p.senderRole === 'coach'
                        ? 'bg-cyan-100 text-cyan-800 ring-1 ring-cyan-200'
                        : 'bg-slate-100 text-slate-700 ring-1 ring-slate-200'
                    }`}>
                      {(p.senderName || '?').charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[15px] font-bold text-slate-900 truncate">{p.senderName}</span>
                        {p.senderRole === 'coach' && (
                          <span className="text-[9px] font-extrabold uppercase tracking-widest text-cyan-700 bg-cyan-50 ring-1 ring-cyan-200 px-1.5 py-0.5 rounded">Coach</span>
                        )}
                      </div>
                      <div className="text-[12px] text-slate-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
                        <span>{p.timestamp.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-extrabold uppercase tracking-widest ${tone.bg} ${tone.text} ring-1 ${tone.ring}`}>
                          {CATEGORY_LABEL[cat]}
                        </span>
                        {isPinnedTop && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-extrabold uppercase tracking-widest text-amber-800 bg-amber-50 ring-1 ring-amber-200 inline-flex items-center gap-0.5">
                            <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24"><line x1="12" y1="17" x2="12" y2="22" stroke="currentColor" strokeWidth={2}/><path d="M5 17h14l-1.5-3.5L17 5H7l-.5 8.5L5 17z" stroke="currentColor" strokeWidth={2}/></svg>
                            Pinned
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <article className="px-4 pb-3 text-slate-800 break-words text-[15.5px] leading-relaxed">
                    <RichContent text={p.content} />
                  </article>

                  {/* Attachments — full-bleed on mobile (no horizontal
                      padding) so images look like an Instagram card. */}
                  {p.attachments && p.attachments.length > 0 && (
                    p.attachments.length === 1 ? (
                      <img
                        src={p.attachments[0].url}
                        alt={p.attachments[0].name || 'attachment'}
                        loading="lazy"
                        className="block w-full max-h-[520px] object-cover bg-slate-100"
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                      />
                    ) : (
                      <div className="grid grid-cols-2 gap-0.5 bg-slate-100">
                        {p.attachments.slice(0, 4).map((a, i) => (
                          <img
                            key={i}
                            src={a.url}
                            alt={a.name || 'attachment'}
                            loading="lazy"
                            className="block w-full h-44 sm:h-52 object-cover bg-slate-100"
                            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                          />
                        ))}
                      </div>
                    )
                  )}

                  {/* Engagement bar — like + comment counts surfaced
                      OUTSIDE the action buttons so people scrolling can
                      see the post's traction without tapping. */}
                  {(likes.length > 0 || (commentCounts[p.id] || 0) > 0) && (
                    <div className="px-4 pt-3 pb-1 flex items-center gap-3 text-[12px] text-slate-500">
                      {likes.length > 0 && (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-rose-500 text-white">
                            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                          </span>
                          {likes.length}
                        </span>
                      )}
                      {(commentCounts[p.id] || 0) > 0 && (
                        <button onClick={() => toggleExpand(p.id)} className="ml-auto hover:text-cyan-700 font-semibold">
                          {commentCounts[p.id]} {commentCounts[p.id] === 1 ? 'comment' : 'comments'}
                        </button>
                      )}
                    </div>
                  )}

                  {/* Action footer — dark navy strip with cyan accents.
                      Matches the rest of the app's branded chrome
                      (chat action sheet header, emoji picker header,
                      composer modal). Gives each card a polished
                      "front page" feel rather than the flat white
                      Slack-ish look. */}
                  <div className="bg-gradient-to-b from-slate-950 to-slate-900 px-2 py-1 flex items-center justify-around">
                    <button
                      type="button"
                      onClick={() => toggleLike(p)}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[12px] font-extrabold uppercase tracking-widest transition active:scale-95 ${
                        myLike ? 'text-rose-300' : 'text-cyan-200/80 hover:text-white'
                      }`}
                    >
                      <svg className="w-5 h-5" fill={myLike ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                      </svg>
                      Like
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleExpand(p.id)}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[12px] font-extrabold uppercase tracking-widest text-cyan-200/80 hover:text-white active:scale-95"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                      </svg>
                      Comment
                    </button>
                    <button
                      type="button"
                      onClick={() => shareToWeb(p)}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[12px] font-extrabold uppercase tracking-widest active:scale-95 ${
                        (p as any).isPublic ? 'text-emerald-300 hover:text-emerald-200' : 'text-cyan-200/80 hover:text-white'
                      }`}
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                      Share
                    </button>
                    {canManage && (
                      <button
                        type="button"
                        onClick={() => {
                          const action = window.prompt(
                            `Manage post:\n\n1 = ${isPinnedTop ? 'Unpin' : 'Pin to top'}\n2 = Delete\n\nType 1 or 2:`,
                            ''
                          );
                          if (action === '1') void togglePinTop(p);
                          if (action === '2') void removePost(p);
                        }}
                        aria-label="Manage post"
                        className="w-10 py-2 flex items-center justify-center rounded-lg text-cyan-200/60 hover:text-white active:scale-95"
                      >
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg>
                      </button>
                    )}
                  </div>

                  {/* Inline preview of last 2 comments — always visible
                      so engagement feels alive. Tap "View all" or any
                      comment to expand the full thread + composer. */}
                  {previewComments.length > 0 && !expanded[p.id] && (
                    <div className="px-4 pb-3 border-t border-slate-100 pt-2 space-y-1.5">
                      {hiddenCount > 0 && (
                        <button
                          type="button"
                          onClick={() => toggleExpand(p.id)}
                          className="text-[12px] text-slate-500 hover:text-cyan-700 font-semibold"
                        >
                          View all {commentCounts[p.id]} comments
                        </button>
                      )}
                      {previewComments.map(c => (
                        <div key={c.id} className="text-[13.5px] text-slate-800 leading-snug">
                          <span className="font-bold text-slate-900">{c.senderName}</span>{' '}
                          <span className="break-words">{c.content}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {expanded[p.id] && (
                    <div className="border-t border-slate-100 bg-slate-50 px-4 py-3 space-y-3">
                      {commentsForPost.length > 0 && (
                        <ul className="space-y-2.5">
                          {commentsForPost.map(c => (
                            <li key={c.id} className="flex items-start gap-2.5">
                              <div className="w-8 h-8 rounded-full bg-cyan-50 ring-1 ring-cyan-100 flex items-center justify-center text-[11px] font-extrabold text-cyan-700 shrink-0">
                                {(c.senderName || '?').charAt(0).toUpperCase()}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="rounded-2xl bg-white ring-1 ring-slate-200 px-3 py-2">
                                  <div className="flex items-baseline gap-2">
                                    <span className="text-[13px] font-bold text-slate-900">{c.senderName}</span>
                                    <span className="text-[10px] text-slate-400">
                                      {c.timestamp.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                                    </span>
                                  </div>
                                  <p className="text-[14px] text-slate-800 whitespace-pre-wrap break-words mt-0.5">{c.content}</p>
                                </div>
                                {(c.senderId === userData?.uid || canManage) && (
                                  <button
                                    type="button"
                                    onClick={() => deleteComment(c)}
                                    className="mt-1 text-[10px] text-slate-400 hover:text-rose-600 underline underline-offset-2"
                                  >
                                    Delete
                                  </button>
                                )}
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                      {userData && (
                        <div className="flex items-start gap-2.5">
                          <div className="w-8 h-8 rounded-full bg-cyan-100 ring-1 ring-cyan-200 flex items-center justify-center text-[11px] font-extrabold text-cyan-800 shrink-0">
                            {(userData.name || '?').charAt(0).toUpperCase()}
                          </div>
                          <div className="flex-1 flex items-center gap-2">
                            <input
                              value={commentDrafts[p.id] || ''}
                              onChange={(e) => setCommentDrafts(prev => ({ ...prev, [p.id]: e.target.value }))}
                              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submitComment(p.id); } }}
                              placeholder="Write a comment…"
                              className="flex-1 px-3 py-2 rounded-full ring-1 ring-slate-200 focus:ring-2 focus:ring-cyan-400 text-sm bg-white"
                              style={{ fontSize: '16px' }}
                            />
                            <button
                              type="button"
                              onClick={() => void submitComment(p.id)}
                              disabled={!(commentDrafts[p.id] || '').trim()}
                              className="px-3 py-2 rounded-full bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-extrabold uppercase tracking-widest disabled:opacity-40"
                            >
                              Send
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
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

export const RichContent: React.FC<{ text: string }> = ({ text }) => {
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
    // Inline image — a line that is JUST a markdown image renders as
    // a block-level figure, not nested inside a <p>. Captions and
    // additional inline content go on adjacent lines.
    const imgMatch = trimmed.match(/^!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)$/);
    if (imgMatch) {
      flushAll(`img-${i}`);
      blocks.push(
        <img
          key={`img-${i}`}
          src={imgMatch[2]}
          alt={imgMatch[1] || ''}
          loading="lazy"
          className="block my-3 rounded-xl w-full max-h-[520px] object-cover ring-1 ring-slate-200"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
      );
      return;
    }
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
