import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { addDoc, collection, deleteDoc, doc, getDoc, onSnapshot, orderBy, query, serverTimestamp, updateDoc, where } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../contexts/AuthContext';
import { useTeam } from '../contexts/TeamContext';
import { isCoach, resolveSenderRole } from '../utils/helpers';
import { uploadToR2 } from '../utils/r2Upload';
import AppIcon from '../components/common/AppIcon';
import EmptyState from '../components/common/EmptyState';
import EmojiPicker from '../components/chat/EmojiPicker';
import WallPollCard from '../components/wall/WallPollCard';
import WallEditor from '../components/wall/WallEditor';
import GameRecapCard from '../components/wall/GameRecapCard';
import PotmWinnerCard from '../components/wall/PotmWinnerCard';
import TrialGateModal from '../components/common/TrialGateModal';
import { useTrialGate } from '../hooks/useTrialGate';
import { marked } from 'marked';
import type { WallPost, WallComment } from '../types';

// Convert legacy markdown posts to HTML so the TipTap editor can
// open them for edit. marked() is sync and small (~30kb); we only
// call it when a user opens an old markdown post for editing.
function markdownToHTML(md: string): string {
  try {
    return marked.parse(md, { async: false }) as string;
  } catch {
    return md;
  }
}

// Plain-text fallback used by push previews and the dashboard
// snippet, given an HTML body. Strips tags + collapses whitespace.
function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

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
        className="text-brand-primary underline break-all"
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

  // Stamp last-seen so the header notifications bar drops the wall
  // pill once the user has looked. Reuses the existing
  // wall.lastSeen.<teamId> key WallHeaderButton set before the
  // unified header bar shipped.
  useEffect(() => {
    (async () => {
      try {
        const { markWallSeen } = await import('../components/common/NotificationsHeaderBar');
        markWallSeen(selectedTeamId || null);
      } catch { /* ignore */ }
    })();
  }, [selectedTeamId]);

  const [posts, setPosts] = useState<WallPost[]>([]);
  const [loading, setLoading] = useState(true);
  // ATOMIC RENDER: empty silence → 400ms progress hint → atomic
  // fade-in. Same pattern as chat thread list (commit 4b379fb) and
  // dashboard streak card (commit 0e540ff). Pattern: feedback memory
  // 'atomic-render-over-skeletons.md'. Replaces the SkeletonCard
  // pattern that was here before.
  const [showProgress, setShowProgress] = useState(false);
  const [hardTimeoutFired, setHardTimeoutFired] = useState(false);
  const ready = hardTimeoutFired || !loading;
  React.useEffect(() => {
    const t = window.setTimeout(() => setHardTimeoutFired(true), 2000);
    return () => window.clearTimeout(t);
  }, []);
  React.useEffect(() => {
    if (ready) { setShowProgress(false); return; }
    const t = window.setTimeout(() => setShowProgress(true), 400);
    return () => window.clearTimeout(t);
  }, [ready]);
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

  // Wall tabs — the culture spine's own information architecture.
  // Feed is the mixed chronological stream. The other tabs are lenses
  // that filter down to specific provenance / content. Composer keeps
  // its own category picker (below) so coach posts can be tagged, but
  // the top nav is provenance-based because that's how humans think
  // about the wall ("show me recaps" not "show me category=result").
  type WallCategory = NonNullable<WallPost['category']>;
  type WallTab = 'feed' | 'media' | 'recaps' | 'awards' | 'news';
  const CATEGORIES: Array<{ id: WallTab; label: string }> = [
    { id: 'feed', label: 'Feed' },
    { id: 'media', label: 'Media' },
    { id: 'recaps', label: 'Recaps' },
    { id: 'awards', label: 'Awards' },
    { id: 'news', label: 'News' },
  ];
  const CATEGORY_TONE: Record<WallCategory, { text: string; bg: string; ring: string }> = {
    announcement: { text: 'text-brand-primary-soft', bg: 'bg-brand-primary/150/15', ring: 'ring-brand-primary-soft/30' },
    result: { text: 'text-emerald-300', bg: 'bg-emerald-500/15', ring: 'ring-emerald-400/30' },
    spotlight: { text: 'text-amber-300', bg: 'bg-amber-500/15', ring: 'ring-amber-400/30' },
    practice: { text: 'text-violet-300', bg: 'bg-violet-500/15', ring: 'ring-violet-400/30' },
    system: { text: 'text-ink-primary/85', bg: 'bg-line-default/[0.08]', ring: 'ring-line-default/10' },
  };
  const CATEGORY_LABEL: Record<WallCategory, string> = {
    announcement: 'News',
    result: 'Result',
    spotlight: 'Spotlight',
    practice: 'Practice',
    system: 'Auto',
  };
  const [activeCategory, setActiveCategory] = useState<WallTab>('feed');
  const [composerCategory, setComposerCategory] = useState<WallCategory>('announcement');
  // The composer used to live at the top of the feed and Patrick had
  // to scroll past it every time. It now opens from a floating +
  // button, the way Instagram / Facebook do new-post creation.
  const [composerOpen, setComposerOpen] = useState(false);
  const { gated: trialGated, reason: trialReason } = useTrialGate();
  const [trialGateOpen, setTrialGateOpen] = useState(false);

  // Poll composer state — when on, the post is published with an
  // attached poll. Question + 2-6 options + single-choice vs multi.
  const [pollOn, setPollOn] = useState(false);
  // Optional 'also send via email' toggle. Off by default so we
  // don't spam parents on every wall post. Stored separately from
  // pollOn so a coach can email + poll together (the email
  // template includes a Vote button linking back to the post).
  const [emailBlast, setEmailBlast] = useState(false);
  const [pollQuestion, setPollQuestion] = useState('');
  const [pollOptions, setPollOptions] = useState<string[]>(['', '']);
  const resetPoll = () => {
    setPollOn(false);
    setPollQuestion('');
    setPollOptions(['', '']);
  };

  // Edit mode — when set, the composer modal saves back to this post
  // via updateDoc instead of creating a new wall_posts doc. Polls
  // aren't editable here (vote state would need to be merged); the
  // composer shows the existing poll as a read-only block so the
  // coach can confirm the votes aren't being wiped, with an optional
  // "remove poll" path for cleaning up a mistake.
  const [editingPostId, setEditingPostId] = useState<string | null>(null);
  const [existingPoll, setExistingPoll] = useState<WallPost['poll'] | null>(null);
  const [removeExistingPoll, setRemoveExistingPoll] = useState(false);

  // Per-post action sheet (pin / edit / delete). Replaces the legacy
  // window.prompt that asked for "1 or 2" — the sheet matches the
  // chat-action-sheet UX and gives Edit its own home.
  const [managePostId, setManagePostId] = useState<string | null>(null);

  const userPhotoUrl = (userData?.photoURL || userData?.profilePhotoUrl || null) as string | null;

  // Fast-path uid → name lookup for the poll voter sheet. Built
  // from data we already have in memory (current user + every
  // post / comment author on screen). The poll card lazy-fetches
  // any uid not in this map, so callers don't need exhaustive
  // coverage — this just avoids unnecessary Firestore reads for
  // people who've already shown up on this page.
  const knownNameByUid = React.useCallback((uid: string): string | undefined => {
    if (userData?.uid === uid) return userData.name || undefined;
    for (const p of posts) if (p.senderId === uid && p.senderName) return p.senderName;
    for (const list of Object.values(comments)) {
      for (const c of list) if (c.senderId === uid && c.senderName) return c.senderName;
    }
    return undefined;
  }, [userData?.uid, userData?.name, posts, comments]);

  // Open the composer pre-populated to edit an existing post.
  // Posts authored after the TipTap editor shipped are stored as
  // HTML (`contentFormat: 'tiptap-html'`). Posts predating that
  // store the raw markdown text. We convert markdown → HTML on the
  // way in so old posts open cleanly in the rich editor.
  const openEdit = (post: WallPost) => {
    if (!canManage) return;
    setEditingPostId(post.id);
    const raw = post.content || '';
    const isHtml = (post as any).contentFormat === 'tiptap-html';
    setComposer(isHtml ? raw : markdownToHTML(raw));
    setComposerAttachments(Array.isArray(post.attachments) ? post.attachments.map(a => ({ url: a.url, name: a.name || '', type: a.type || '' })) : []);
    setComposerCategory((post.category || 'announcement') as WallCategory);
    setPreviewMode(false);
    resetPoll();
    setExistingPoll(post.poll || null);
    setRemoveExistingPoll(false);
    setManagePostId(null);
    setComposerOpen(true);
  };

  // Closing the composer should always clear edit mode so the next
  // open is a clean "New post" — without this, hitting Cancel mid-
  // edit would leave editingPostId set and the next + tap would
  // overwrite that post.
  const closeComposer = () => {
    setComposerOpen(false);
    setEditingPostId(null);
    setExistingPoll(null);
    setRemoveExistingPoll(false);
    setEmailBlast(false);
  };

  // Vote / unvote on a post's poll. Single-choice (default) means
  // voting on option B removes your vote from option A first.
  const voteOnPoll = async (post: WallPost, optionId: string) => {
    if (!userData?.uid || !post.poll) return;
    const uid = userData.uid;
    const multi = !!post.poll.multi;
    const nextOptions = post.poll.options.map(o => {
      const had = o.voters.includes(uid);
      if (o.id === optionId) {
        return { ...o, voters: had ? o.voters.filter(u => u !== uid) : [...o.voters, uid] };
      }
      // Single-choice → remove this user's vote from every other option
      // when they cast on a new one. Skip if user wasn't voting here.
      if (!multi && !had) return { ...o, voters: o.voters.filter(u => u !== uid) };
      return o;
    });
    const nextPoll = { ...post.poll, options: nextOptions };
    setPosts(prev => prev.map(p => p.id === post.id ? { ...p, poll: nextPoll } : p));
    try {
      await updateDoc(doc(db, 'wall_posts', post.id), { poll: nextPoll });
    } catch (err) {
      console.error('poll vote failed', err);
      setPosts(prev => prev.map(p => p.id === post.id ? { ...p, poll: post.poll } : p));
    }
  };

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
        // Inverted mapping: spread the raw Firestore doc through,
        // then explicitly OVERRIDE the fields that need normalization
        // (timestamps converted, defaults applied, malformed shapes
        // sanitized). Anything not listed below just rides through
        // unchanged — which means new schema fields (contentFormat,
        // viewedBy, isPublic, emailedAt, the next thing someone
        // adds) automatically reach the UI without needing this
        // function to be touched. Three different fields silently
        // dropped through this map in 2026-06-27 alone — refactor
        // is the only way to stop firefighting the same bug class.
        return {
          ...(data as WallPost),
          id: d.id,
          content: data.content || '',
          senderName: data.senderName || 'Coach',
          senderPhotoUrl: data.senderPhotoUrl || null,
          timestamp: data.timestamp?.toDate?.() || new Date(data.timestamp || Date.now()),
          editedAt: typeof data.editedAt === 'number' ? data.editedAt : null,
          attachments: Array.isArray(data.attachments) ? data.attachments : undefined,
          reactions: Array.isArray(data.reactions) ? data.reactions : [],
          wallPinnedTop: typeof data.wallPinnedTop === 'number' ? data.wallPinnedTop : null,
          isPublic: !!data.isPublic,
          emailedAt: typeof data.emailedAt === 'number' ? data.emailedAt : null,
          category: data.category || 'announcement',
          poll: data.poll && typeof data.poll === 'object' && Array.isArray(data.poll.options)
            ? {
                question: String(data.poll.question || ''),
                multi: !!data.poll.multi,
                options: data.poll.options.map((o: any) => ({
                  id: String(o.id),
                  text: String(o.text || ''),
                  voters: Array.isArray(o.voters) ? o.voters : [],
                })),
              }
            : undefined,
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
            senderPhotoUrl: data.senderPhotoUrl || null,
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

  // ─── View tracking ──────────────────────────────────────────
  // When a wall post scrolls into view for ≥1s, write the current
  // user's uid into post.viewedBy as a server timestamp. Author + coach
  // / admin sees a "Seen by N" pill. Parents never see surveillance,
  // they just see the wall.
  //
  // One IntersectionObserver shared across all posts (not one per
  // post) so we don't burn a JS observer per row. The "already marked
  // this session" Set caches uid-confirmed posts so we don't re-write
  // when the user scrolls back over a post they already saw.
  const markedViewedRef = useRef<Set<string>>(new Set());
  const dwellTimersRef = useRef<Map<string, number>>(new Map());

  // Seed the "already marked" set with any posts whose viewedBy
  // already includes my uid — that way switching teams / cold start
  // doesn't double-write.
  useEffect(() => {
    if (!userData?.uid) return;
    const seen = markedViewedRef.current;
    for (const p of posts) {
      const v = (p as any).viewedBy || {};
      if (v[userData.uid]) seen.add(p.id);
    }
  }, [posts, userData?.uid]);

  useEffect(() => {
    if (!userData?.uid || typeof IntersectionObserver === 'undefined') return;
    const myUid = userData.uid;
    const seen = markedViewedRef.current;
    const dwell = dwellTimersRef.current;

    const writeViewed = async (postId: string) => {
      if (seen.has(postId)) return;
      seen.add(postId);
      try {
        await updateDoc(doc(db, 'wall_posts', postId), {
          [`viewedBy.${myUid}`]: serverTimestamp(),
        });
      } catch (err) {
        // Roll the cache back on failure so a transient rules / network
        // hiccup doesn't lock us out of ever marking this post viewed.
        seen.delete(postId);
        console.warn('[wall] mark viewed failed', postId, err);
      }
    };

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        const postId = el.getAttribute('data-post-id');
        if (!postId) continue;
        if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
          if (dwell.has(postId)) continue;
          // 1s dwell prevents fast-scroll fly-bys from counting as a view.
          const timer = window.setTimeout(() => {
            dwell.delete(postId);
            void writeViewed(postId);
          }, 1000);
          dwell.set(postId, timer);
        } else {
          const t = dwell.get(postId);
          if (t) { window.clearTimeout(t); dwell.delete(postId); }
        }
      }
    }, { threshold: [0, 0.5, 1] });

    document.querySelectorAll('li[data-post-id]').forEach(el => observer.observe(el));

    return () => {
      observer.disconnect();
      dwell.forEach((t) => window.clearTimeout(t));
      dwell.clear();
    };
  }, [posts, userData?.uid]);

  const toggleExpand = (postId: string) => {
    setExpanded(prev => {
      const next = { ...prev, [postId]: !prev[postId] };
      // When opening, scroll the post into view so the user can see
      // the comments section + composer (it was getting hidden behind
      // the bottom nav, forcing a hunt-scroll). One frame delay so
      // the expanded DOM has actually rendered.
      if (next[postId]) {
        requestAnimationFrame(() => {
          const el = document.getElementById(`wall-comments-${postId}`);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      }
      return next;
    });
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
        senderPhotoUrl: userPhotoUrl,
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

  // Post a new wall_posts doc OR update an existing one when
  // editingPostId is set. Edits update content / attachments /
  // category in place and refresh the avatar snapshot — they do NOT
  // re-send the push, since parents already got pinged on the
  // original post.
  const handlePost = async () => {
    // composer now holds HTML emitted by TipTap. We treat an editor
    // that only contains an empty paragraph as "no content" so an
    // image-only post (a single <img>) still counts. The plainText
    // version drives the push notification body + the empty-check.
    const content = composer.trim();
    const plainText = htmlToPlainText(content);
    const hasImage = /<img\s/i.test(content);
    const hasPoll = pollOn && pollQuestion.trim().length > 0 && pollOptions.filter(o => o.trim()).length >= 2;
    if ((!plainText && !hasImage && composerAttachments.length === 0 && !hasPoll) || !userData || !selectedTeamId || posting) return;
    setPosting(true);
    setPostError(null);
    let newPostId: string | null = null;
    try {
      if (editingPostId) {
        await updateDoc(doc(db, 'wall_posts', editingPostId), {
          content,
          contentFormat: 'tiptap-html',
          senderName: userData.name || 'Coach',
          senderPhotoUrl: userPhotoUrl,
          attachments: composerAttachments.length > 0 ? composerAttachments : null,
          category: composerCategory,
          editedAt: Date.now(),
          // Poll handling on edit:
          // - existingPoll + removeExistingPoll → wipe the poll
          // - existingPoll + !removeExistingPoll → don't touch field
          //   (Firestore leaves it as-is on a partial update)
          // - !existingPoll + pollOn → user added a poll while editing
          // - !existingPoll + !pollOn → nothing changes
          ...(existingPoll && removeExistingPoll
            ? { poll: null }
            : !existingPoll && pollOn && pollQuestion.trim() && pollOptions.filter(o => o.trim()).length >= 2
              ? {
                  poll: {
                    question: pollQuestion.trim(),
                    multi: false,
                    options: pollOptions
                      .map(t => t.trim())
                      .filter(t => t.length > 0)
                      .map((text, i) => ({ id: `o_${Date.now()}_${i}`, text, voters: [] as string[] })),
                  },
                }
              : {}),
        });
      } else {
        const newRef = await addDoc(collection(db, 'wall_posts'), {
          teamId: selectedTeamId,
          content,
          contentFormat: 'tiptap-html',
          senderId: userData.uid,
          senderName: userData.name || 'Coach',
          senderPhotoUrl: userPhotoUrl,
          senderRole: (isCoach(userData.role) || (userData as any).isClubAdmin)
            ? 'coach'
            : resolveSenderRole(userData),
          timestamp: new Date(),
          attachments: composerAttachments.length > 0 ? composerAttachments : null,
          reactions: [],
          wallPinnedTop: null,
          postedFrom: 'wall',
          isPublic: false,
          category: composerCategory,
          editedAt: null,
          // Only attach a poll if the composer has it ON, a question,
          // and at least 2 non-empty options. Each option gets a stable
          // id so vote-toggle updates land on the right one.
          ...(pollOn && pollQuestion.trim() && pollOptions.filter(o => o.trim()).length >= 2
            ? {
                poll: {
                  question: pollQuestion.trim(),
                  multi: false,
                  options: pollOptions
                    .map(t => t.trim())
                    .filter(t => t.length > 0)
                    .map((text, i) => ({ id: `o_${Date.now()}_${i}`, text, voters: [] as string[] })),
                },
              }
            : {}),
        });
        newPostId = newRef.id;
      }
      const wasEdit = !!editingPostId;
      setComposer('');
      setComposerAttachments([]);
      setComposerCategory('announcement');
      resetPoll();
      setEmailBlast(false);
      setPreviewMode(false);
      setEditingPostId(null);
      try { localStorage.removeItem(draftKey(selectedTeamId)); } catch { /* ignore */ }
      setDraftStatus('idle');
      // Push only fires on NEW posts. Edits silently update — parents
      // already got pinged on the original.
      if (!wasEdit) {
        try {
          const { sendPushToTeam } = await import('../utils/notify');
          void sendPushToTeam(
            selectedTeamId,
            {
              title: `${userData.name || 'Coach'} posted on Team Wall`,
              body: (plainText.slice(0, 140) || 'New announcement'),
              url: '/wall',
            },
            { excludeUid: userData.uid },
          );
        } catch (e) { console.warn('wall push failed', e); }

        // Optional email blast — only fires when the coach
        // explicitly opted in via the composer toggle. Poll posts
        // get a 'Vote in the poll' button deep-linked back to the
        // public wall post URL so a recipient can vote without
        // logging in.
        if (emailBlast && newPostId) {
          try {
            const { tplWallPost, sendEmailToTeam } = await import('../utils/notify');
            const { wallPostShareUrl } = await import('./PublicWallPost');
            // Flip the post to public so the share URL renders
            // for non-app recipients. Best-effort — if this fails
            // the email still goes; the button just links to /wall.
            try {
              await updateDoc(doc(db, 'wall_posts', newPostId), { isPublic: true });
            } catch (e) { console.warn('wall isPublic flip failed', e); }
            const teamObj = selectedTeam as any;
            const tpl = tplWallPost({
              teamName: teamObj?.name || 'your team',
              senderName: userData.name || 'Coach',
              contentHtml: content,
              category: composerCategory,
              pollQuestion: hasPoll ? pollQuestion.trim() : null,
              postUrl: wallPostShareUrl(newPostId),
              signature: { name: userData.name || 'Coach', role: 'Coach', teamName: teamObj?.name },
            });
            // Fire-and-forget; failures already log inside notify.
            void sendEmailToTeam(selectedTeamId, tpl, { excludeUid: userData.uid });
            // Stamp emailedAt so the manage-post sheet can show
            // "Resend email" instead of "Email to team" and warn on
            // accidental double-send. Best-effort — failure here is
            // cosmetic (worst case the label says "Email to team"
            // when it should say "Resend").
            try {
              await updateDoc(doc(db, 'wall_posts', newPostId), { emailedAt: Date.now() });
            } catch (e) { console.warn('wall emailedAt stamp failed', e); }
          } catch (e) { console.warn('wall email blast failed', e); }
        }
      }
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

  // Email an existing post out to the team. Same payload as the
  // creation-time email blast (tplWallPost + sendEmailToTeam),
  // gated by a confirm prompt so it's not one-tap accidental.
  // Stamps emailedAt on the post for the manage sheet to read.
  const emailExistingPost = async (post: WallPost) => {
    if (!canManage || !userData) return;
    // Use the POST's teamId, not selectedTeamId. The user could have
    // switched teams since posting — selectedTeamId would resolve
    // the wrong roster. The post itself knows what team it belongs to.
    const postTeamId = post.teamId || selectedTeamId;
    if (!postTeamId) return;
    const alreadySent = !!post.emailedAt;
    const teamObj = selectedTeam as any;
    const teamName = teamObj?.name || 'your team';
    const confirmMsg = alreadySent
      ? `This post was already emailed ${fmtRelativeShort(post.emailedAt!)}. Send it again to everyone on ${teamName}?`
      : `Send this post as an email to everyone on ${teamName}?`;
    if (!window.confirm(confirmMsg)) return;
    try {
      const { tplWallPost, getTeamEmails, sendEmailBatch } = await import('../utils/notify');
      const { wallPostShareUrl } = await import('./PublicWallPost');
      // Make sure the public share URL works for non-app recipients
      // before the email goes out. Best-effort flip.
      if (!post.isPublic) {
        try { await updateDoc(doc(db, 'wall_posts', post.id), { isPublic: true }); }
        catch (e) { console.warn('isPublic flip failed', e); }
      }
      // Resolve the recipient list FIRST so we can give an honest
      // error message — the wrapper sendEmailToTeam() returns 0 for
      // BOTH "no emails found" AND "send failed", which lied to
      // Patrick when the worker config was missing.
      const emails = await getTeamEmails(postTeamId, userData.uid);
      console.log('[wall] email-to-team recipient resolution', {
        teamId: postTeamId, count: emails.length, sample: emails.slice(0, 3),
      });
      if (emails.length === 0) {
        alert('No team emails found. Check that parents are signed up + have an email on file.');
        return;
      }
      const tpl = tplWallPost({
        teamName,
        senderName: post.senderName || userData.name || 'Coach',
        contentHtml: post.content || '',
        category: post.category || null,
        pollQuestion: post.poll?.question || null,
        postUrl: wallPostShareUrl(post.id),
        signature: { name: userData.name || 'Coach', role: 'Coach', teamName },
      });
      const messages = emails.map((to) => ({ to, subject: tpl.subject, html: tpl.html }));
      const ok = await sendEmailBatch(messages);
      if (!ok) {
        alert(`Found ${emails.length} ${emails.length === 1 ? 'recipient' : 'recipients'} but the email service rejected the send. Check the worker config (NOTIFY_URL / NOTIFY_SECRET) and try again.`);
        return;
      }
      await updateDoc(doc(db, 'wall_posts', post.id), { emailedAt: Date.now() });
      alert(`Email sent to ${emails.length} ${emails.length === 1 ? 'person' : 'people'}.`);
    } catch (err) {
      console.error('email existing post failed', err);
      alert('Email failed — try again. The post itself is fine.');
    }
  };

  function fmtRelativeShort(ms: number): string {
    const diff = Date.now() - ms;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  }

  // Like / unlike a wall post (kept for the inline ♥ tap).
  const toggleLike = async (post: WallPost) => {
    await toggleReaction(post, '❤️');
  };

  // Toggle any emoji reaction on a wall post. Each user can hold ONE
  // instance per emoji (toggle = remove if present, add otherwise).
  const toggleReaction = async (post: WallPost, emoji: string) => {
    if (!userData?.uid) return;
    const reactions = post.reactions || [];
    const mine = reactions.find(r => r.userId === userData.uid && r.emoji === emoji);
    const next = mine
      ? reactions.filter(r => !(r.userId === userData.uid && r.emoji === emoji))
      : [...reactions, { emoji, userId: userData.uid, userName: userData.name || 'Friend' }];
    setPosts(prev => prev.map(p => p.id === post.id ? { ...p, reactions: next } : p));
    try {
      await updateDoc(doc(db, 'wall_posts', post.id), { reactions: next });
    } catch (err) {
      console.error('reaction toggle failed', err);
      setPosts(prev => prev.map(p => p.id === post.id ? { ...p, reactions } : p));
    }
  };

  // Wall post reaction picker — opens the same EmojiPicker the chat
  // uses so reactions feel consistent across the app.
  const [reactingPostId, setReactingPostId] = useState<string | null>(null);
  // ID of the post whose reactor-list sheet is open (so parents can
  // see WHO reacted with what — Patrick: "can we also see who
  // reacted on the wall posts?"). Tap a chip → toggle (existing).
  // Tap the "Who reacted" link in the engagement bar → opens this
  // sheet, grouped by emoji.
  const [reactorsPostId, setReactorsPostId] = useState<string | null>(null);
  // ID of the post whose viewer-list sheet is open. Patrick: "the
  // ability to view who saw the wall post has been taken away."
  // The 'X seen' chip was always non-interactive — this turns it
  // into a tap target and renders the same kind of name list the
  // reactor sheet does. Same author + admin gate as canSeeSeen.
  const [viewersPostId, setViewersPostId] = useState<string | null>(null);
  const [viewerNamesByUid, setViewerNamesByUid] = useState<Record<string, string>>({});

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
      // Resize before upload so the inline image renders fast on every
      // viewer's device. 1600px on the longer edge keeps phone retina
      // quality without the 3-8 MB raw camera files that used to lag
      // the wall on cellular. GIFs skip the pass to preserve animation.
      let toUpload: File = file;
      if (!file.type.includes('gif')) {
        try {
          const { resizeImage } = await import('../utils/imageResize');
          const resized = await resizeImage(file, 1600, 0.85);
          toUpload = new File(
            [resized.blob],
            file.name.replace(/\.[a-z0-9]+$/i, '.jpg'),
            { type: 'image/jpeg' },
          );
        } catch (err) {
          console.warn('[wall] image resize skipped', err);
        }
      }
      const r = await uploadToR2(toUpload, 'wall_media');
      const final = r.url;
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

  // Inline image upload for the TipTap editor — same resize +
  // R2 pipeline as the legacy handler, but returns just the URL
  // so WallEditor can insert an Image node at the cursor. No
  // composer-string mutation here; TipTap handles insertion.
  const uploadInlineImage = async (file: File): Promise<string> => {
    let toUpload: File = file;
    if (!file.type.includes('gif')) {
      try {
        const { resizeImage } = await import('../utils/imageResize');
        const resized = await resizeImage(file, 1600, 0.85);
        toUpload = new File(
          [resized.blob],
          file.name.replace(/\.[a-z0-9]+$/i, '.jpg'),
          { type: 'image/jpeg' },
        );
      } catch (err) {
        console.warn('[wall] image resize skipped', err);
      }
    }
    const r = await uploadToR2(toUpload, 'wall_media');
    return r.url;
  };

  // Filter feed by selected Wall tab. Filters are provenance + content
  // based rather than category-based because that's how people think
  // about the wall ("show me the recaps" not "show me category=result").
  //   feed    → everything
  //   media   → posts with attachments (photo/video)
  //   recaps  → game-recap auto-posts (postedFrom='game')
  //   awards  → POTM / juggle PR / dev-plan-complete auto-posts
  //   news    → manual coach posts (postedFrom='wall' or absent)
  const filteredPosts = posts.filter(p => {
    if (activeCategory === 'feed') return true;
    if (activeCategory === 'media') {
      return Array.isArray(p.attachments) && p.attachments.length > 0;
    }
    if (activeCategory === 'recaps') return p.postedFrom === 'game';
    if (activeCategory === 'awards') {
      return p.postedFrom === 'potm' || p.postedFrom === 'juggle' || p.postedFrom === 'devplan';
    }
    if (activeCategory === 'news') {
      return !p.postedFrom || p.postedFrom === 'wall';
    }
    return true;
  });

  return (
    <div className="min-h-screen bg-surface-base">
      {/* Compact mobile header — no big hero strip eating screen real
          estate. Title row + pill filter on a single sticky stack. */}
      <section className="bg-surface-base px-4 sm:px-6 py-3 border-b border-line-default/5">
        <div className="max-w-2xl mx-auto flex items-center justify-between gap-2">
          <Link to="/dashboard" aria-label="Back" className="inline-flex items-center justify-center w-8 h-8 rounded-full text-brand-primary-soft hover:bg-line-default/10">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
          </Link>
          <h1 className="text-base sm:text-lg font-black text-ink-primary flex items-center gap-1.5">
            <AppIcon name="news" className="w-4 h-4 text-brand-primary-soft" />
            <span className="tracking-tight">Team Wall</span>
          </h1>
          {canPost ? (
            <button
              type="button"
              onClick={() => {
                if (trialGated) { setTrialGateOpen(true); return; }
                setComposerOpen(true);
              }}
              className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-brand-primary hover:bg-brand-primary/150 active:scale-95 text-white text-[11px] font-extrabold uppercase tracking-widest transition shadow-sm"
              aria-label="New post"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Post
            </button>
          ) : (
            <span className="w-8" aria-hidden />
          )}
        </div>
      </section>

      {/* Category pills — wrap to a second row on narrow screens
          instead of scrolling sideways (Patrick's rule: sideways
          scrolling of pills = layout is wrong). Post button lives
          on the top bar above so this row is purely filter. */}
      <div className="sticky top-0 z-20 bg-surface-base/95 backdrop-blur-md border-b border-line-default/10">
        <div className="max-w-2xl mx-auto px-3 py-2 flex flex-wrap items-center justify-center gap-1.5">
          {CATEGORIES.map(c => (
            <button
              key={c.id}
              type="button"
              onClick={() => setActiveCategory(c.id)}
              className={`px-3.5 py-1.5 rounded-full text-[12px] font-extrabold uppercase tracking-widest transition ${
                activeCategory === c.id
                  ? 'bg-surface-raised text-ink-primary'
                  : 'bg-line-default/[0.06] text-ink-primary/65 ring-1 ring-line-default/10 hover:bg-line-default/[0.1]'
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
            // Composer opens as a FULL-BLEED overlay on mobile (was a
            // half-sheet that let the background bleed through; Patrick
            // couldn't tell the modal from the feed underneath).
            // Desktop stays as a centered pop-in card so wider screens
            // still get chrome to see it's a modal.
            className="fixed inset-0 z-40 bg-surface-base animate-fade-in flex flex-col sm:items-center sm:justify-center sm:p-4 sm:bg-surface-base/95"
            onClick={closeComposer}
          >
            <div
              className="bg-surface-elevated w-full h-full sm:h-auto sm:max-w-2xl sm:rounded-2xl shadow-2xl flex flex-col sm:max-h-[90vh] overflow-hidden animate-sheet-up sm:animate-pop-in"
              style={{
                paddingTop: 'env(safe-area-inset-top)',
                paddingBottom: 'env(safe-area-inset-bottom)',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="bg-gradient-to-b from-surface-base to-surface-elevated px-4 py-3 flex items-center justify-between flex-shrink-0">
                <button
                  type="button"
                  onClick={closeComposer}
                  className="text-[11px] font-extrabold tracking-widest uppercase text-ink-primary/40 hover:text-ink-primary"
                >
                  Cancel
                </button>
                <div className="text-xs font-extrabold tracking-widest uppercase text-brand-primary-soft">
                  {editingPostId ? 'Edit post' : 'New post'}
                </div>
                <button
                  type="button"
                  onClick={async () => { await handlePost(); if (!postError) closeComposer(); }}
                  disabled={!composer.trim() || posting}
                  className="text-[11px] font-extrabold tracking-widest uppercase text-brand-primary-soft hover:text-ink-primary disabled:opacity-40"
                >
                  {posting ? 'Saving…' : (editingPostId ? 'Save' : 'Post')}
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
                      : 'text-ink-primary/50 ring-1 ring-line-default/10 hover:bg-line-default/[0.05]'
                  }`}
                >
                  {CATEGORY_LABEL[cat]}
                </button>
              ))}
            </div>
            {/* WYSIWYG editor — TipTap. Toolbar lives inside the
                component. Replaces the old markdown textarea so coaches
                see bold/italic/lists/images as they type, the way a
                normal blog post editor works. Old markdown posts
                still render via RichContent when read; on edit, they
                convert to HTML via marked() so they open cleanly in
                the rich editor. Patrick: "if a person chooses bold, it
                should just show bold." */}
            <WallEditor
              value={composer}
              onChange={setComposer}
              placeholder="Share an update with the team. Use the toolbar for headings, bold, lists, images, and links."
              uploadImage={uploadInlineImage}
              onUploadingChange={setUploading}
            />

            <div className="px-4 sm:px-6 py-4">

              {/* Poll editor — three states depending on edit mode and
                  whether the post already has a poll attached:
                  1. Editing a post with a poll → read-only preview so
                     the coach can see the votes aren't being wiped.
                     'Remove poll' link if they really want it gone.
                  2. Editing a post with no poll OR creating a new post
                     → the normal editor (toggle + question + options).
                  3. Edit mode + 'remove' chosen → confirmation card
                     with an undo link before save commits. */}
              <div className="mt-4 rounded-xl ring-1 ring-line-default/10 bg-line-default/[0.04] px-3 py-3">
                {existingPoll && !removeExistingPoll ? (
                  <>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <svg className="w-4 h-4 text-brand-primary-soft" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                          <rect x="3" y="12" width="4" height="9" rx="1" />
                          <rect x="10" y="7" width="4" height="14" rx="1" />
                          <rect x="17" y="3" width="4" height="18" rx="1" />
                        </svg>
                        <span className="text-[12px] font-extrabold uppercase tracking-widest text-ink-primary/85">Poll attached</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setRemoveExistingPoll(true)}
                        className="text-[11px] font-extrabold uppercase tracking-widest text-rose-400 hover:text-rose-300"
                      >
                        Remove poll
                      </button>
                    </div>
                    <p className="mt-2 text-[12px] text-ink-primary/50 leading-relaxed">
                      The poll and its votes stay attached when you save. Editing the poll question or options isn't supported — remove and re-create the post if you need to change them.
                    </p>
                    <div className="mt-3 rounded-lg bg-surface-input ring-1 ring-line-default/10 px-3 py-2.5">
                      <p className="font-bold text-[13.5px] text-ink-primary leading-snug">{existingPoll.question}</p>
                      <ul className="mt-2 space-y-1">
                        {existingPoll.options.map(o => (
                          <li key={o.id} className="text-[12.5px] text-ink-primary/85 flex items-start justify-between gap-3">
                            <span className="break-words min-w-0">{o.text}</span>
                            <span className="shrink-0 text-ink-primary/40 tabular-nums">{o.voters.length}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </>
                ) : existingPoll && removeExistingPoll ? (
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[13px] font-bold text-rose-300">Poll will be removed on save</p>
                      <p className="text-[12px] text-ink-primary/50 mt-0.5 leading-snug">All votes will be lost. This can't be undone after you save.</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setRemoveExistingPoll(false)}
                      className="shrink-0 text-[11px] font-extrabold uppercase tracking-widest text-brand-primary-soft hover:text-brand-primary-soft"
                    >
                      Undo
                    </button>
                  </div>
                ) : (
                <>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-brand-primary-soft" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                      <rect x="3" y="12" width="4" height="9" rx="1" />
                      <rect x="10" y="7" width="4" height="14" rx="1" />
                      <rect x="17" y="3" width="4" height="18" rx="1" />
                    </svg>
                    <span className="text-[12px] font-extrabold uppercase tracking-widest text-ink-primary/85">Poll</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPollOn(v => !v)}
                    className={`text-[11px] font-extrabold uppercase tracking-widest px-2.5 py-1 rounded-full transition ${
                      pollOn
                        ? 'bg-brand-primary text-white hover:bg-brand-primary/150'
                        : 'bg-line-default/[0.06] text-ink-primary/65 ring-1 ring-line-default/15 hover:bg-line-default/[0.1]'
                    }`}
                  >
                    {pollOn ? 'On' : 'Add a poll'}
                  </button>
                </div>
                {pollOn && !existingPoll && (
                  <div className="mt-3 space-y-2">
                    <input
                      type="text"
                      value={pollQuestion}
                      onChange={(e) => setPollQuestion(e.target.value)}
                      placeholder="Question (e.g. What practice day works best?)"
                      className="w-full px-3 py-2 rounded-lg ring-1 ring-line-default/15 focus:ring-2 focus:ring-brand-primary-soft text-[15px] bg-surface-input text-ink-primary placeholder:text-ink-primary/30"
                      style={{ fontSize: '16px' }}
                    />
                    {pollOptions.map((opt, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <input
                          type="text"
                          value={opt}
                          onChange={(e) => setPollOptions(prev => prev.map((p, idx) => idx === i ? e.target.value : p))}
                          placeholder={`Option ${i + 1}`}
                          className="flex-1 px-3 py-2 rounded-lg ring-1 ring-line-default/15 focus:ring-2 focus:ring-brand-primary-soft text-[14.5px] bg-surface-input text-ink-primary placeholder:text-ink-primary/30"
                          style={{ fontSize: '16px' }}
                        />
                        {pollOptions.length > 2 && (
                          <button
                            type="button"
                            onClick={() => setPollOptions(prev => prev.filter((_, idx) => idx !== i))}
                            aria-label="Remove option"
                            className="w-8 h-8 rounded-full text-ink-primary/40 hover:text-rose-400 hover:bg-rose-500/150/15 flex items-center justify-center"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                          </button>
                        )}
                      </div>
                    ))}
                    {pollOptions.length < 6 && (
                      <button
                        type="button"
                        onClick={() => setPollOptions(prev => [...prev, ''])}
                        className="text-[12px] font-bold uppercase tracking-widest text-brand-primary-soft hover:text-brand-primary-soft"
                      >
                        + Add option
                      </button>
                    )}
                  </div>
                )}
                </>
                )}
              </div>

              {/* Email blast toggle. Off by default so the wall
                  stays cheap; coaches opt in when a post
                  warrants reaching parents who don't open the
                  app. Hidden during edits since edits don't
                  re-send. */}
              {!editingPostId && (
                <div className="mt-2 rounded-2xl ring-1 ring-line-default/10 bg-surface-elevated/70 px-4 py-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <svg className="w-4 h-4 text-brand-primary-soft shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                        <rect x="3" y="5" width="18" height="14" rx="2" />
                        <path d="M3 7l9 6 9-6" />
                      </svg>
                      <div className="min-w-0">
                        <p className="text-[12px] font-extrabold uppercase tracking-widest text-ink-primary/85">Also email</p>
                        <p className="text-[11px] text-ink-primary/55 leading-snug truncate">
                          {pollOn ? 'Email with a Vote button linking back here.' : 'Email parents who miss app pushes.'}
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setEmailBlast(v => !v)}
                      className={`shrink-0 text-[11px] font-extrabold uppercase tracking-widest px-2.5 py-1 rounded-full transition ${
                        emailBlast
                          ? 'bg-brand-primary text-white'
                          : 'bg-line-default/[0.06] text-ink-primary/65 ring-1 ring-line-default/15 hover:bg-line-default/[0.1]'
                      }`}
                    >
                      {emailBlast ? 'On' : 'Off'}
                    </button>
                  </div>
                </div>
              )}

              {postError && (
                <div className="mt-3 rounded-lg bg-rose-500/15 ring-1 ring-rose-400/30 px-3 py-2 text-[12px] text-rose-300">
                  {postError}
                </div>
              )}
            </div>

            <div className="px-4 sm:px-6 py-2.5 border-t border-line-default/5 bg-line-default/[0.03] flex items-center gap-3 text-[11px] text-ink-primary/50">
              {draftStatus === 'saved' && composer.trim() && (
                <span className="inline-flex items-center gap-1 text-ink-primary/40">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" /></svg>
                  Draft saved
                </span>
              )}
              {composer.trim() && (
                <button
                  type="button"
                  onClick={discardDraft}
                  className="text-ink-primary/40 hover:text-rose-400 underline underline-offset-2"
                >
                  Discard
                </button>
              )}
            </div>
              </div>
            </div>
          </div>
        )}

        {/* (Floating + FAB removed — the new-post CTA now lives inline
            in the sticky category bar above. Patrick: the floating
            button "gets in the way of the three dots and obstructs it
            in other ways". Sticky pill is always visible without
            overlaying any post content.) */}

        {!ready ? (
          // Atomic render: empty silence while we wait. Slim crimson
          // hint appears only if loading crosses 400ms (so fast loads
          // never flash a spinner). When ready, the whole list fades
          // in via the wrapper below.
          showProgress ? (
            <div className="px-4">
              <div className="h-0.5 bg-brand-primary/15 overflow-hidden rounded-full">
                <div className="h-full w-1/3 bg-brand-primary animate-progress-slide" />
              </div>
            </div>
          ) : null
        ) : filteredPosts.length === 0 ? (
          <div className="px-4">
            <EmptyState
              icon={<AppIcon name="news" className="w-5 h-5" />}
              title={
                activeCategory === 'feed' ? 'Nothing on Team Wall yet'
                : activeCategory === 'media' ? 'No media posts yet'
                : activeCategory === 'recaps' ? 'No game recaps yet'
                : activeCategory === 'awards' ? 'No awards to celebrate yet'
                : 'No news posted yet'
              }
              description={
                activeCategory === 'feed'
                  ? (canPost
                    ? 'This is your team\'s story. Game recaps, POTM crowns, tagged clips, and coach news land here automatically. Start one with the + button.'
                    : 'Recaps, awards, and coach news will show up here as the season plays out.')
                  : activeCategory === 'recaps' ? 'Finish a game in GameDay and the recap posts here automatically.'
                  : activeCategory === 'awards' ? 'Player of the Match wins, personal bests, and milestones show up here.'
                  : activeCategory === 'media' ? 'Photos and video clips coaches post will collect here.'
                  : 'Coach announcements land here. Games and awards get their own tabs.'
              }
            />
          </div>
        ) : (
          // animate-fade-in is the atomic-render reveal — whole list
          // appears as one 180ms fade, not item-by-item.
          <ul className="space-y-3 animate-fade-in">
            {filteredPosts.map(p => {
              const myUid = userData?.uid;
              const allReactions = p.reactions || [];
              const likes = allReactions.filter(r => r.emoji === '❤️');
              const myLike = myUid ? likes.some(r => r.userId === myUid) : false;
              // Group reactions by emoji for the chip strip below the
              // post — same UX as chat. Each chip shows count + a
              // "mine" highlight if this user reacted with it.
              const grouped: Record<string, { count: number; mine: boolean }> = {};
              for (const r of allReactions) {
                if (!grouped[r.emoji]) grouped[r.emoji] = { count: 0, mine: false };
                grouped[r.emoji].count++;
                if (myUid && r.userId === myUid) grouped[r.emoji].mine = true;
              }
              const reactionEntries = Object.entries(grouped).sort((a, b) => b[1].count - a[1].count);
              // Quick-tap reactions — always visible strip so parents
              // can react in one tap instead of opening the picker.
              // Any additional emojis added via the picker fall into
              // reactionEntries alongside these. Ordered: love, fire,
              // clap, ball (=goal), trophy (=game).
              const QUICK_EMOJIS = ['❤️', '🔥', '👏', '⚽', '🏆'];
              const quickReactions = QUICK_EMOJIS.map(emoji => ({
                emoji,
                count: grouped[emoji]?.count || 0,
                mine: grouped[emoji]?.mine || false,
              }));
              const extraReactions = reactionEntries.filter(([e]) => !QUICK_EMOJIS.includes(e));
              const isPinnedTop = !!p.wallPinnedTop;
              const cat = (p.category || 'announcement') as WallCategory;
              const tone = CATEGORY_TONE[cat];
              const commentsForPost = comments[p.id] || [];
              const previewComments = commentsForPost.slice(-2);
              const hiddenCount = Math.max(0, (commentCounts[p.id] || commentsForPost.length) - previewComments.length);
              const viewedByMap = ((p as any).viewedBy || {}) as Record<string, unknown>;
              const seenCount = Object.keys(viewedByMap).length;
              const canSeeSeen = !!myUid && (myUid === p.senderId || canManage);
              return (
                <li
                  key={p.id}
                  data-post-id={p.id}
                  className={`bg-surface-elevated sm:rounded-2xl overflow-hidden shadow-sm ${
                    isPinnedTop ? 'ring-2 ring-amber-300' : 'ring-1 ring-line-default/10'
                  }`}
                >
                  {/* Card header — avatar, name + role, time, category
                      pill. Mobile-card design, not a desktop blog
                      post. Avatar prefers the snapshotted senderPhotoUrl
                      from the doc; falls back to the current user's
                      live photo for their own posts (so old posts that
                      predate the snapshot still show a real photo for
                      the author viewing them); falls back to the name
                      initial otherwise. */}
                  <div className="px-4 pt-3.5 pb-3 flex items-center gap-3">
                    <PostAvatar
                      photoUrl={p.senderPhotoUrl || (p.senderId === userData?.uid ? userPhotoUrl : null)}
                      name={p.senderName}
                      variant={p.senderRole === 'coach' ? 'coach' : 'parent'}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[15px] font-bold text-ink-primary truncate">{p.senderName}</span>
                        {p.senderRole === 'coach' && (
                          <span className="text-[9px] font-extrabold uppercase tracking-widest text-brand-primary-soft bg-brand-primary/150/15 ring-1 ring-brand-primary-soft/30 px-1.5 py-0.5 rounded">Coach</span>
                        )}
                        {p.senderRole === 'player' && (
                          <span className="text-[9px] font-extrabold uppercase tracking-widest text-amber-300 bg-amber-500/15 ring-1 ring-amber-400/30 px-1.5 py-0.5 rounded">Player</span>
                        )}
                      </div>
                      <div className="text-[12px] text-ink-primary/50 mt-0.5 flex items-center gap-1.5 flex-wrap">
                        <span>{p.timestamp.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                        {p.editedAt && (
                          <span className="italic text-ink-primary/40">· edited</span>
                        )}
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-extrabold uppercase tracking-widest ${tone.bg} ${tone.text} ring-1 ${tone.ring}`}>
                          {CATEGORY_LABEL[cat]}
                        </span>
                        {isPinnedTop && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-extrabold uppercase tracking-widest text-amber-300 bg-amber-500/15 ring-1 ring-amber-400/30 inline-flex items-center gap-0.5">
                            <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24"><line x1="12" y1="17" x2="12" y2="22" stroke="currentColor" strokeWidth={2}/><path d="M5 17h14l-1.5-3.5L17 5H7l-.5 8.5L5 17z" stroke="currentColor" strokeWidth={2}/></svg>
                            Pinned
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Hero cards — swap in when the post carries a
                      structured payload:
                        recap       → GameRecapCard (game auto-posts)
                        potmResult  → PotmWinnerCard (POTM close)
                      Absent both → fall through to markdown body so
                      legacy posts still render.  */}
                  {(p as any).recap ? (
                    <div className="px-3 pb-3">
                      <GameRecapCard recap={(p as any).recap} timestamp={p.timestamp} />
                    </div>
                  ) : (p as any).potmResult ? (
                    <div className="px-3 pb-3">
                      <PotmWinnerCard potm={(p as any).potmResult} timestamp={p.timestamp} />
                    </div>
                  ) : p.content ? (
                    <article className="px-4 pb-3 text-ink-primary/90 break-words text-[15.5px] leading-relaxed">
                      {(p as any).contentFormat === 'tiptap-html' ? (
                        <div
                          className="tiptap-rendered"
                          // TipTap output is schema-constrained — only
                          // the nodes/marks our extensions allow are
                          // ever serialized. No <script>, no inline
                          // JS, no iframes. Safe to render directly.
                          dangerouslySetInnerHTML={{ __html: p.content }}
                        />
                      ) : (
                        <RichContent text={p.content} />
                      )}
                    </article>
                  ) : null}

                  {p.poll && (
                    <WallPollCard
                      poll={p.poll}
                      currentUserId={userData?.uid || ''}
                      onVote={(optionId) => void voteOnPoll(p, optionId)}
                      canSeeVoters={canManage}
                      getUserName={knownNameByUid}
                    />
                  )}

                  {/* Attachments — full-bleed on mobile (no horizontal
                      padding) so images look like an Instagram card.
                      Videos (type='video' or file extension match)
                      render as inline playable elements: Cloudflare
                      Stream URLs get an iframe embed, direct-hosted
                      MP4/WebM/MOV get a native <video> element with
                      controls. Photos keep the existing <img> render. */}
                  {p.attachments && p.attachments.length > 0 && (
                    p.attachments.length === 1 ? (
                      <WallAttachment a={p.attachments[0]} single />
                    ) : (
                      <div className="grid grid-cols-2 gap-0.5 bg-surface-input">
                        {p.attachments.slice(0, 4).map((a, i) => (
                          <WallAttachment key={i} a={a} />
                        ))}
                      </div>
                    )
                  )}

                  {/* Reaction row — only shown when at least one
                      person has reacted OR there are comments / seen
                      counts to surface. Empty posts stay clean; the
                      React button in the footer opens the full picker
                      for a first reaction. Chips are the sum of
                      quick emojis (heart/fire/clap/soccer/trophy)
                      with count > 0 + any custom emojis added via
                      the picker. */}
                  {(quickReactions.some(q => q.count > 0) || extraReactions.length > 0 || (commentCounts[p.id] || 0) > 0 || (canSeeSeen && seenCount > 0)) && (
                  <div className="px-4 pt-3 pb-1 flex items-center gap-1.5 flex-wrap text-[12px] text-ink-primary/50">
                    {quickReactions.filter(q => q.count > 0).map(({ emoji, count, mine }) => (
                      <button
                        key={emoji}
                        type="button"
                        onClick={() => void toggleReaction(p, emoji)}
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[13px] ring-1 transition active:scale-95 ${
                          mine
                            ? 'bg-brand-primary/15 ring-brand-primary-soft/40 text-brand-primary-soft'
                            : 'bg-line-default/[0.04] ring-line-default/10 text-ink-primary/85 hover:bg-line-default/[0.08]'
                        }`}
                        aria-label={`React with ${emoji}`}
                      >
                        <span className="text-sm leading-none">{emoji}</span>
                        <span className="font-semibold tabular-nums">{count}</span>
                      </button>
                    ))}
                    {extraReactions.map(([emoji, info]) => (
                      <button
                        key={emoji}
                        type="button"
                        onClick={() => void toggleReaction(p, emoji)}
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[13px] ring-1 transition ${
                          info.mine
                            ? 'bg-brand-primary/15 ring-brand-primary-soft/40 text-brand-primary-soft'
                            : 'bg-line-default/[0.04] ring-line-default/10 text-ink-primary/85 hover:bg-line-default/[0.08]'
                        }`}
                      >
                        <span className="text-sm leading-none">{emoji}</span>
                        <span className="font-semibold tabular-nums">{info.count}</span>
                      </button>
                    ))}
                    {reactionEntries.length > 0 && (
                      <button
                        onClick={() => setReactorsPostId(p.id)}
                        className="text-[10px] font-bold uppercase tracking-widest text-brand-primary-soft hover:text-brand-primary"
                      >
                        Who reacted →
                      </button>
                    )}
                    {(commentCounts[p.id] || 0) > 0 && (
                      <button onClick={() => toggleExpand(p.id)} className="ml-auto hover:text-brand-primary-soft font-semibold">
                        {commentCounts[p.id]} {commentCounts[p.id] === 1 ? 'comment' : 'comments'}
                      </button>
                    )}
                    {canSeeSeen && seenCount > 0 && (
                      <button
                        type="button"
                        onClick={() => setViewersPostId(p.id)}
                        className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-ink-primary/55 hover:text-brand-primary-soft transition-colors ${(commentCounts[p.id] || 0) > 0 ? '' : 'ml-auto'}`}
                        title="See who's viewed this post"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
                        </svg>
                        {seenCount} seen
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
                  <div className="bg-gradient-to-b from-surface-base to-surface-elevated px-2 py-1 flex items-center justify-around">
                    <button
                      type="button"
                      onClick={() => setReactingPostId(p.id)}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[12px] font-extrabold uppercase tracking-widest transition active:scale-95 ${
                        myLike ? 'text-rose-300' : 'text-ink-primary/80 hover:text-ink-primary'
                      }`}
                    >
                      <svg className="w-5 h-5" fill={myLike ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                      </svg>
                      React
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleExpand(p.id)}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[12px] font-extrabold uppercase tracking-widest text-ink-primary/80 hover:text-ink-primary active:scale-95"
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
                        (p as any).isPublic ? 'text-emerald-300 hover:text-emerald-200' : 'text-ink-primary/80 hover:text-ink-primary'
                      }`}
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                      Share
                    </button>
                    {canManage && (
                      <button
                        type="button"
                        onClick={() => setManagePostId(p.id)}
                        aria-label="Manage post"
                        className="w-10 py-2 flex items-center justify-center rounded-lg text-ink-primary/60 hover:text-ink-primary active:scale-95"
                      >
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg>
                      </button>
                    )}
                  </div>

                  {/* Inline preview of last 2 comments — always visible
                      so engagement feels alive. Tap "View all" or any
                      comment to expand the full thread + composer. */}
                  {previewComments.length > 0 && !expanded[p.id] && (
                    <div className="px-4 pb-3 border-t border-line-default/5 pt-2 space-y-1.5">
                      {hiddenCount > 0 && (
                        <button
                          type="button"
                          onClick={() => toggleExpand(p.id)}
                          className="text-[12px] text-ink-primary/50 hover:text-brand-primary-soft font-semibold"
                        >
                          View all {commentCounts[p.id]} comments
                        </button>
                      )}
                      {previewComments.map(c => (
                        <div key={c.id} className="text-[13.5px] text-ink-primary/90 leading-snug">
                          <span className="font-bold text-ink-primary">{c.senderName}</span>{' '}
                          <span className="break-words">{c.content}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {expanded[p.id] && (
                    <div id={`wall-comments-${p.id}`} className="border-t border-line-default/5 bg-line-default/[0.04] px-4 py-3 space-y-3">
                      {commentsForPost.length > 0 && (
                        <ul className="space-y-2.5">
                          {commentsForPost.map(c => (
                            <li key={c.id} className="flex items-start gap-2.5">
                              <PostAvatar
                                photoUrl={c.senderPhotoUrl || (c.senderId === userData?.uid ? userPhotoUrl : null)}
                                name={c.senderName}
                                size="sm"
                                variant="parent"
                              />
                              <div className="flex-1 min-w-0">
                                <div className="rounded-2xl bg-surface-input ring-1 ring-line-default/10 px-3 py-2">
                                  <div className="flex items-baseline gap-2">
                                    <span className="text-[13px] font-bold text-ink-primary">{c.senderName}</span>
                                    <span className="text-[10px] text-ink-primary/40">
                                      {c.timestamp.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                                    </span>
                                  </div>
                                  <p className="text-[14px] text-ink-primary/90 whitespace-pre-wrap break-words mt-0.5">{c.content}</p>
                                </div>
                                {(c.senderId === userData?.uid || canManage) && (
                                  <button
                                    type="button"
                                    onClick={() => deleteComment(c)}
                                    className="mt-1 text-[10px] text-ink-primary/40 hover:text-rose-400 underline underline-offset-2"
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
                          <PostAvatar
                            photoUrl={userPhotoUrl}
                            name={userData.name}
                            size="sm"
                            variant={isCoach(userData.role) || (userData as any).isClubAdmin ? 'coach' : 'parent'}
                          />
                          <div className="flex-1 flex items-center gap-2">
                            <input
                              value={commentDrafts[p.id] || ''}
                              onChange={(e) => setCommentDrafts(prev => ({ ...prev, [p.id]: e.target.value }))}
                              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submitComment(p.id); } }}
                              placeholder="Write a comment…"
                              className="flex-1 px-3 py-2 rounded-full ring-1 ring-line-default/10 focus:ring-2 focus:ring-brand-primary-soft text-sm bg-surface-input text-ink-primary placeholder:text-ink-primary/30"
                              style={{ fontSize: '16px' }}
                            />
                            <button
                              type="button"
                              onClick={() => void submitComment(p.id)}
                              disabled={!(commentDrafts[p.id] || '').trim()}
                              className="px-3 py-2 rounded-full bg-brand-primary hover:bg-brand-primary/150 text-white text-xs font-extrabold uppercase tracking-widest disabled:opacity-40"
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

      {/* Wall reaction picker — same EmojiPicker the chat uses, so
          reactions feel consistent. Closes on pick / dim tap. */}
      {reactingPostId && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in"
          onClick={() => setReactingPostId(null)}
        >
          <div onClick={(e) => e.stopPropagation()} className="w-full sm:max-w-md animate-sheet-up sm:animate-pop-in">
            <EmojiPicker
              onPick={(emoji) => {
                const target = posts.find(p => p.id === reactingPostId);
                if (target) void toggleReaction(target, emoji);
                setReactingPostId(null);
              }}
              onClose={() => setReactingPostId(null)}
            />
          </div>
        </div>
      )}

      {/* Reactor list — opened from the "Who reacted →" link in each
          post's engagement bar. Groups reactions by emoji and lists
          the names that reacted with each. Dark-navy header chrome
          matches the rest of the app's sheet pattern. */}
      {reactorsPostId && (() => {
        const target = posts.find(p => p.id === reactorsPostId);
        if (!target) return null;
        const grouped: Record<string, Array<{ uid: string; name: string }>> = {};
        for (const r of target.reactions || []) {
          if (!grouped[r.emoji]) grouped[r.emoji] = [];
          grouped[r.emoji].push({ uid: r.userId, name: r.userName || 'Member' });
        }
        const emojis = Object.keys(grouped).sort((a, b) => grouped[b].length - grouped[a].length);
        const total = (target.reactions || []).length;
        return (
          <div
            className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in"
            onClick={() => setReactorsPostId(null)}
          >
            <div
              className="bg-surface-elevated w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[80vh] overflow-hidden animate-sheet-up sm:animate-pop-in"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="bg-gradient-to-b from-surface-base to-surface-elevated px-4 py-3 flex items-center justify-between flex-shrink-0">
                <button onClick={() => setReactorsPostId(null)} className="text-[11px] font-extrabold tracking-widest uppercase text-ink-primary/40 hover:text-ink-primary">
                  Close
                </button>
                <div className="text-xs font-extrabold tracking-widest uppercase text-brand-primary-soft">
                  {total} {total === 1 ? 'reaction' : 'reactions'}
                </div>
                <span className="w-12" aria-hidden />
              </div>
              <div className="flex-1 overflow-y-auto" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
                {emojis.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-ink-primary/50">No reactions yet.</div>
                ) : (
                  emojis.map(emoji => (
                    <div key={emoji} className="border-b border-line-default/5 last:border-b-0">
                      <div className="px-4 py-2 bg-line-default/[0.04] flex items-center justify-between">
                        <span className="text-base">{emoji}</span>
                        <span className="text-[11px] font-bold uppercase tracking-widest text-ink-primary/50">
                          {grouped[emoji].length}
                        </span>
                      </div>
                      <ul>
                        {grouped[emoji].map(r => (
                          <li key={r.uid} className="px-4 py-2 text-[14px] text-ink-primary/90 border-b border-slate-50 last:border-b-0">
                            {r.name}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Viewer list — opened from the "X seen" chip in each post's
          engagement bar. Same pattern as the reactor list above.
          Hydrates uid → name on open: known names come from in-memory
          lookup, unknowns lazy-fetch from /users/{uid}. */}
      {viewersPostId && (() => {
        const target = posts.find(p => p.id === viewersPostId);
        if (!target) return null;
        const viewedBy = ((target as any).viewedBy || {}) as Record<string, any>;
        const uids = Object.keys(viewedBy);
        // Sort: most-recent view first. viewedBy values are
        // Firestore Timestamps stamped via serverTimestamp().
        uids.sort((a, b) => {
          const at = viewedBy[a]?.toMillis ? viewedBy[a].toMillis() : 0;
          const bt = viewedBy[b]?.toMillis ? viewedBy[b].toMillis() : 0;
          return bt - at;
        });
        // Hydrate any unknown names so the list doesn't read "Member,
        // Member, Member, ...". Fires once per modal open.
        const missing = uids.filter((uid) => !knownNameByUid(uid) && !viewerNamesByUid[uid]);
        if (missing.length > 0) {
          (async () => {
            const pairs: Array<[string, string]> = [];
            for (const uid of missing) {
              try {
                const snap = await getDoc(doc(db, 'users', uid));
                if (snap.exists()) {
                  const n = (snap.data() as any).name || (snap.data() as any).displayName;
                  if (n) pairs.push([uid, n]);
                }
              } catch { /* non-fatal */ }
            }
            if (pairs.length > 0) {
              setViewerNamesByUid((prev) => ({ ...prev, ...Object.fromEntries(pairs) }));
            }
          })();
        }
        const nameFor = (uid: string) => knownNameByUid(uid) || viewerNamesByUid[uid] || uid.slice(0, 8) + '…';
        return (
          <div
            className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in"
            onClick={() => setViewersPostId(null)}
          >
            <div
              className="bg-surface-elevated w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[80vh] overflow-hidden animate-sheet-up sm:animate-pop-in"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="bg-gradient-to-b from-surface-base to-surface-elevated px-4 py-3 flex items-center justify-between flex-shrink-0">
                <button onClick={() => setViewersPostId(null)} className="text-[11px] font-extrabold tracking-widest uppercase text-ink-primary/40 hover:text-ink-primary">
                  Close
                </button>
                <div className="text-xs font-extrabold tracking-widest uppercase text-brand-primary-soft">
                  {uids.length} {uids.length === 1 ? 'viewer' : 'viewers'}
                </div>
                <span className="w-12" aria-hidden />
              </div>
              <div className="flex-1 overflow-y-auto" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
                {uids.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-ink-primary/50">No views yet.</div>
                ) : (
                  <ul>
                    {uids.map((uid) => {
                      const ts = viewedBy[uid];
                      const ms = ts?.toMillis ? ts.toMillis() : (ts instanceof Date ? ts.getTime() : null);
                      return (
                        <li key={uid} className="px-4 py-2.5 text-[14px] text-ink-primary/90 border-b border-line-default/5 last:border-b-0 flex items-center justify-between gap-2">
                          <span className="truncate">{nameFor(uid)}</span>
                          {ms && (
                            <span className="text-[11px] text-ink-primary/45 shrink-0 tabular-nums">
                              {new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Manage-post action sheet — replaces the legacy window.prompt
          that asked the coach to type 1 or 2. Pin / Edit / Delete in
          a proper bottom sheet so Edit gets its own home and the dark-
          navy chrome matches the rest of the app's sheets. */}
      {managePostId && (() => {
        const target = posts.find(p => p.id === managePostId);
        if (!target) return null;
        const isPinned = !!target.wallPinnedTop;
        return (
          <div
            className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in"
            onClick={() => setManagePostId(null)}
          >
            <div
              className="bg-surface-elevated w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden animate-sheet-up sm:animate-pop-in"
              style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="bg-gradient-to-b from-surface-base to-surface-elevated px-4 py-3 flex items-center justify-between">
                <span className="w-12" aria-hidden />
                <div className="text-xs font-extrabold tracking-widest uppercase text-brand-primary-soft">Manage post</div>
                <button
                  type="button"
                  onClick={() => setManagePostId(null)}
                  className="text-[11px] font-extrabold tracking-widest uppercase text-ink-primary/40 hover:text-ink-primary"
                >
                  Close
                </button>
              </div>
              <ul className="divide-y divide-slate-100">
                <li>
                  <button
                    type="button"
                    onClick={() => { void togglePinTop(target); setManagePostId(null); }}
                    className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-line-default/[0.05] active:bg-line-default/[0.1]"
                  >
                    <svg className="w-5 h-5 text-amber-600 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                      <line x1="12" y1="17" x2="12" y2="22" />
                      <path d="M5 17h14l-1.5-3.5L17 5H7l-.5 8.5L5 17z" />
                    </svg>
                    <span className="text-[15px] font-bold text-ink-primary">{isPinned ? 'Unpin from top' : 'Pin to top'}</span>
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => { setManagePostId(null); void emailExistingPost(target); }}
                    className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-line-default/[0.05] active:bg-line-default/[0.1]"
                  >
                    <svg className="w-5 h-5 text-sky-300 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                      <polyline points="22,6 12,13 2,6" />
                    </svg>
                    <div className="flex-1">
                      <span className="text-[15px] font-bold text-ink-primary block">
                        {target.emailedAt ? 'Resend email' : 'Email to team'}
                      </span>
                      {target.emailedAt && (
                        <span className="text-[11px] text-ink-primary/55 block mt-0.5">
                          Last sent {fmtRelativeShort(target.emailedAt)}
                        </span>
                      )}
                    </div>
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => openEdit(target)}
                    className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-line-default/[0.05] active:bg-line-default/[0.1]"
                  >
                    <svg className="w-5 h-5 text-brand-primary-soft shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                      <path d="M12 20h9" />
                      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
                    </svg>
                    <span className="text-[15px] font-bold text-ink-primary">Edit post</span>
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => { setManagePostId(null); void removePost(target); }}
                    className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-rose-500/150/15 active:bg-rose-100"
                  >
                    <svg className="w-5 h-5 text-rose-400 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
                      <path d="M10 11v6M14 11v6" />
                    </svg>
                    <span className="text-[15px] font-bold text-rose-300">Delete post</span>
                  </button>
                </li>
              </ul>
            </div>
          </div>
        );
      })()}
      <TrialGateModal
        open={trialGateOpen}
        onClose={() => setTrialGateOpen(false)}
        action="post to the team wall"
        reason={trialReason}
      />
    </div>
  );
};

// ── Avatar for wall posts + comments ──────────────────────────
// Renders an <img> when a senderPhotoUrl is available, otherwise
// falls back to the original initial-circle treatment. Same look
// in both spots so post + comment + composer-row read as one.

const PostAvatar: React.FC<{
  photoUrl?: string | null;
  name?: string | null;
  size?: 'sm' | 'md';
  variant?: 'coach' | 'parent';
}> = ({ photoUrl, name, size = 'md', variant = 'parent' }) => {
  const sz = size === 'sm' ? 'w-8 h-8 text-[11px]' : 'w-10 h-10 text-[15px]';
  const ring = variant === 'coach' ? 'ring-brand-primary-soft/30' : 'ring-line-default/10';
  if (photoUrl) {
    return (
      <img
        src={photoUrl}
        alt={name || ''}
        loading="lazy"
        className={`${sz} rounded-full object-cover shrink-0 ring-1 ${ring} bg-line-default/[0.1]`}
        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
      />
    );
  }
  return (
    <div
      className={`${sz} rounded-full flex items-center justify-center font-extrabold shrink-0 ring-1 ${
        variant === 'coach'
          ? 'bg-brand-primary-soft text-brand-primary-soft ring-brand-primary-soft/30'
          : 'bg-line-default/[0.08] text-ink-primary/85 ring-line-default/10'
      }`}
    >
      {(name || '?').charAt(0).toUpperCase()}
    </div>
  );
};

// ── Toolbar building blocks ────────────────────────────────────

const ToolGroup: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="inline-flex items-center border-r border-line-default/10 last:border-r-0 pr-1 mr-1 last:pr-0 last:mr-0">
    {children}
  </div>
);

const ToolbarBtn: React.FC<{ title: string; onClick: () => void; icon: React.ReactNode }> = ({ title, onClick, icon }) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    aria-label={title}
    className="inline-flex items-center justify-center w-8 h-8 rounded-md text-ink-primary/85 hover:bg-line-default/[0.08] active:bg-line-default/[0.12] transition"
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

// ── Attachment renderer ────────────────────────────────────────
// Photos → <img>. Videos → inline player: Cloudflare Stream URLs
// get the iframe embed with autoplay disabled (poster/thumbnail
// shown until tap → controls). Direct-hosted MP4/WebM/MOV get a
// native <video> with controls + playsInline + poster fallback.
// `single` = the post has exactly one attachment; render at full
// height instead of the multi-attachment grid tile.
const isVideoAttachment = (a: { url: string; type?: string }): boolean => {
  if ((a.type || '').startsWith('video')) return true;
  const url = (a.url || '').toLowerCase();
  return /\.(mp4|webm|mov|m4v)(\?|$)/.test(url) || url.includes('cloudflarestream.com') || url.includes('videodelivery.net') || url.includes('iframe.cloudflarestream.com');
};
const isStreamAttachment = (url: string): boolean =>
  url.includes('cloudflarestream.com') || url.includes('videodelivery.net') || url.includes('iframe.cloudflarestream.com');

const WallAttachment: React.FC<{ a: { url: string; name?: string; type?: string }; single?: boolean }> = ({ a, single }) => {
  const isVideo = isVideoAttachment(a);
  if (isVideo) {
    if (isStreamAttachment(a.url)) {
      // Extract the Stream uid if we can — the Stream iframe embed
      // wants uid, not a direct video URL. Falls back to the raw
      // URL when it's already a full iframe embed link.
      const uidMatch = a.url.match(/(?:cloudflarestream\.com|videodelivery\.net)\/([A-Za-z0-9]+)/);
      const embed = uidMatch
        ? `https://iframe.cloudflarestream.com/${uidMatch[1]}`
        : a.url;
      return (
        <div className={`bg-black ${single ? 'aspect-video w-full' : 'aspect-video w-full'}`}>
          <iframe
            src={embed}
            className="w-full h-full block"
            allow="accelerometer; gyroscope; encrypted-media; picture-in-picture;"
            allowFullScreen
            title={a.name || 'video'}
          />
        </div>
      );
    }
    return (
      <div className={`bg-black ${single ? '' : 'aspect-video'}`}>
        <video
          src={a.url}
          className={`block w-full ${single ? 'max-h-[520px]' : 'aspect-video object-cover'} bg-black`}
          controls
          playsInline
          preload="metadata"
        />
      </div>
    );
  }
  return single ? (
    <img
      src={a.url}
      alt={a.name || 'attachment'}
      loading="lazy"
      className="block w-full max-h-[520px] object-cover bg-surface-input"
      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
    />
  ) : (
    <img
      src={a.url}
      alt={a.name || 'attachment'}
      loading="lazy"
      className="block w-full h-44 sm:h-52 object-cover bg-surface-input"
      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
    />
  );
};

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
      <ul key={keyPrefix} className="list-disc pl-6 my-3 space-y-1.5 marker:text-brand-primary">
        {items.map((b, i) => <li key={i} className="pl-1">{renderInline(b)}</li>)}
      </ul>
    );
  };
  const flushOrdered = (keyPrefix: string) => {
    if (orderedBuffer.length === 0) return;
    const items = orderedBuffer.slice();
    orderedBuffer = [];
    blocks.push(
      <ol key={keyPrefix} className="list-decimal pl-6 my-3 space-y-1.5 marker:text-brand-primary marker:font-bold">
        {items.map((b, i) => <li key={i} className="pl-1">{renderInline(b)}</li>)}
      </ol>
    );
  };
  const flushQuote = (keyPrefix: string) => {
    if (quoteBuffer.length === 0) return;
    const text = quoteBuffer.join('\n');
    quoteBuffer = [];
    blocks.push(
      <blockquote key={keyPrefix} className="my-4 pl-4 border-l-4 border-brand-primary-soft text-ink-primary/65 italic whitespace-pre-wrap">
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
          className="block my-3 rounded-xl w-full max-h-[520px] object-cover ring-1 ring-line-default/10"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
      );
      return;
    }
    // Horizontal rule
    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      flushAll(`hr-${i}`);
      blocks.push(<hr key={`hr-${i}`} className="my-5 border-t border-line-default/10" />);
      return;
    }
    // Headings
    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      flushAll(`h-${i}`);
      const level = headingMatch[1].length;
      const inner = renderInline(headingMatch[2]);
      if (level === 1) blocks.push(<h2 key={`h-${i}`} className="text-2xl sm:text-3xl font-black text-ink-primary leading-tight mt-5 mb-3 first:mt-0">{inner}</h2>);
      else if (level === 2) blocks.push(<h3 key={`h-${i}`} className="text-xl sm:text-2xl font-extrabold text-ink-primary leading-snug mt-5 mb-2 first:mt-0">{inner}</h3>);
      else blocks.push(<h4 key={`h-${i}`} className="text-base sm:text-lg font-extrabold text-ink-primary uppercase tracking-wide mt-4 mb-2 first:mt-0">{inner}</h4>);
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
        <a key={key++} href={linkMatch[2]} target="_blank" rel="noopener noreferrer" className="text-brand-primary underline">
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
        out.push(<code key={key++} className="px-1 py-0.5 rounded bg-line-default/[0.08] text-ink-primary/85 text-[13px] font-mono">{text.slice(i + 1, end)}</code>);
        i = end + 1;
        continue;
      }
    }
    // Bare URL
    const urlMatch = text.slice(i).match(/^(https?:\/\/[^\s]+)/);
    if (urlMatch) {
      out.push(
        <a key={key++} href={urlMatch[1]} target="_blank" rel="noopener noreferrer" className="text-brand-primary underline break-all">
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
