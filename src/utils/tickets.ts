// @ts-nocheck
import {
  addDoc,
  arrayUnion,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db } from './firebase';
import type {
  SupportTicket as Ticket,
  SupportTicketMessage as TicketMessage,
  SupportTicketScope as TicketScope,
  SupportTicketStatus as TicketStatus,
  SupportTicketPriority as TicketPriority,
} from '../types';

const MAX_RECENT_MESSAGES = 20;

interface OpenTicketOpts {
  scope: TicketScope;
  subject: string;
  body: string;
  clubId?: string;
  teamId?: string;
  authorUid: string;
  authorName: string;
  authorEmail: string;
  tags?: string[];
  priority?: TicketPriority;
}

/** Create a new ticket. Used by both the in-app form and any future
 *  programmatic openers (e.g. crash auto-file). */
export async function openTicket(opts: OpenTicketOpts): Promise<string> {
  const now = new Date();
  const firstMessage: TicketMessage = {
    id: `m_${Date.now()}`,
    authorUid: opts.authorUid,
    authorName: opts.authorName,
    authorEmail: opts.authorEmail,
    source: 'in-app',
    body: opts.body.trim(),
    sentAt: now,
  };
  const doc: Partial<Ticket> & { recentMessages: TicketMessage[] } = {
    scope: opts.scope,
    status: 'open',
    priority: opts.priority || 'normal',
    subject: opts.subject.trim().slice(0, 200),
    bodyPreview: opts.body.trim().slice(0, 300),
    authorUid: opts.authorUid,
    authorName: opts.authorName,
    authorEmail: opts.authorEmail,
    recentMessages: [firstMessage],
    tags: opts.tags || [],
    createdAt: now,
    updatedAt: now,
    lastReplyAt: now,
    lastTouchedBy: opts.authorUid,
  };
  if (opts.scope === 'club' && opts.clubId) (doc as any).clubId = opts.clubId;
  if (opts.teamId) (doc as any).teamId = opts.teamId;
  const ref = await addDoc(collection(db, 'support_tickets'), doc);
  return ref.id;
}

interface ReplyOpts {
  ticketId: string;
  authorUid: string;
  authorName: string;
  authorEmail: string;
  body: string;
  /** Optional status flip (e.g. 'pending' when admin replies to a parent). */
  setStatus?: TicketStatus;
}

export async function replyToTicket(opts: ReplyOpts): Promise<void> {
  const now = new Date();
  const ref = doc(db, 'support_tickets', opts.ticketId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('ticket not found');
  const data: any = snap.data();
  const message: TicketMessage = {
    id: `m_${Date.now()}`,
    authorUid: opts.authorUid,
    authorName: opts.authorName,
    authorEmail: opts.authorEmail,
    source: 'in-app',
    body: opts.body.trim(),
    sentAt: now,
  };
  const prev: TicketMessage[] = Array.isArray(data.recentMessages) ? data.recentMessages : [];
  const recent = [...prev, message].slice(-MAX_RECENT_MESSAGES);

  await updateDoc(ref, {
    recentMessages: recent,
    updatedAt: now,
    lastReplyAt: now,
    lastTouchedBy: opts.authorUid,
    ...(opts.setStatus ? { status: opts.setStatus } : {}),
  });
}

export async function setTicketStatus(ticketId: string, status: TicketStatus, actorUid: string): Promise<void> {
  await updateDoc(doc(db, 'support_tickets', ticketId), {
    status,
    updatedAt: new Date(),
    lastTouchedBy: actorUid,
  });
}

/** All tickets authored by this user, newest first. */
export async function listMyTickets(uid: string, max = 50): Promise<Ticket[]> {
  const q = query(
    collection(db, 'support_tickets'),
    where('authorUid', '==', uid),
    orderBy('updatedAt', 'desc'),
    limit(max),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
}

/** Club inbox: every ticket filed to this clubId, newest first. */
export async function listClubInbox(clubId: string, max = 100): Promise<Ticket[]> {
  const q = query(
    collection(db, 'support_tickets'),
    where('clubId', '==', clubId),
    where('scope', '==', 'club'),
    orderBy('updatedAt', 'desc'),
    limit(max),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
}

export async function getTicket(ticketId: string): Promise<Ticket | null> {
  const snap = await getDoc(doc(db, 'support_tickets', ticketId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...(snap.data() as any) };
}
