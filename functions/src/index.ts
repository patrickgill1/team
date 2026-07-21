/**
 * Server-driven push fan-out.
 *
 * The OLD model: the sender's phone reads recipients, pulls tokens, calls
 * the Cloudflare Worker /send-push. If the sender's app got backgrounded
 * by iOS between writing the message and POSTing tokens (extremely common
 * on a soccer field), the push for that message silently never fired.
 *
 * This trigger runs on the server the instant a chat_messages doc is
 * created, so the sender's connection is no longer in the delivery path.
 * It also writes a push_attempts/{messageId} document for every send,
 * giving the coach a per-message "Sent: 12 · Failed: 3" view they
 * literally couldn't get before.
 *
 * User-side controls are unchanged: pushPreferences.chat, mutedByUids
 * (thread mute), mutedUserIds (per-user mute) and isActive: false on the
 * recipient user doc are all honored exactly as the client used to honor
 * them.
 */
import {onDocumentCreated} from "firebase-functions/v2/firestore";
import {setGlobalOptions} from "firebase-functions/v2";
import {logger} from "firebase-functions";
import {initializeApp} from "firebase-admin/app";
import {getFirestore, FieldValue} from "firebase-admin/firestore";
import {getMessaging} from "firebase-admin/messaging";

initializeApp();

// us-central1 keeps things colocated with the default Firestore region.
// Concurrency=80 means one warm container handles up to 80 concurrent
// messages — Patrick's whole club fits in one container's worth of load.
setGlobalOptions({
  region: "us-central1",
  maxInstances: 10,
  concurrency: 80,
});

interface ChatMessage {
  id?: string;
  threadId: string;
  content?: string;
  senderId: string;
  senderName?: string;
  senderRole?: string;
  timestamp?: FirebaseFirestore.Timestamp | Date;
  teamId?: string;
  attachments?: unknown[];
  // Skip-push escape hatches we may want later (e.g. system messages,
  // back-fills). Default behavior is to push every new message.
  _skipPush?: boolean;
}

interface ChatThread {
  id: string;
  title?: string;
  participants?: string[];
  mutedByUids?: string[];
  isDM?: boolean;
  isGroup?: boolean;
  scope?: "team" | "club" | string;
  teamId?: string;
  // Groups post-2026-07-21 keep the coach's viewing team here so
  // server-side team-scoped checks (demo/notifications-off kill
  // switch) still work after teamId gets cleared for privacy.
  originTeamId?: string;
}

interface UserDoc {
  uid?: string;
  isActive?: boolean;
  fcmTokens?: string[];
  mutedUserIds?: string[];
  pushPreferences?: {
    chat?: boolean;
    events?: boolean;
    helpdesk?: boolean;
    broadcast?: boolean;
  };
  name?: string;
}

const APP_ORIGIN =
  process.env.APP_ORIGIN || "https://app.goalkickr.com";

/**
 * Replay of the client's effectiveParticipants() rule so the fan-out
 * matches what the chat UI tells the user is in the thread.
 *
 * DM / Group  → fixed participants list on the thread doc.
 * Team scope  → CURRENT team roster (queried fresh), not the
 *               participants array (which grew over time and never
 *               pruned departed members).
 * Other       → thread.participants.
 */
async function resolveRecipientUids(
  thread: ChatThread,
): Promise<string[]> {
  const isDM = thread.isDM === true;
  const isGroup = thread.isGroup === true;
  const scope = thread.scope || "team";

  if (isDM || isGroup) return thread.participants || [];

  if (scope === "team" && thread.teamId) {
    const db = getFirestore();
    // Match the client's two-path team lookup: legacy `teamId == X`
    // for single-team users, plus `teamIds array-contains X` for the
    // newer multi-team model.
    const uids = new Set<string>();
    try {
      const s1 = await db
        .collection("users")
        .where("teamId", "==", thread.teamId)
        .get();
      s1.forEach((d) => {
        const u = d.data() as UserDoc;
        const id = u.uid || d.id;
        if (id) uids.add(id);
      });
      const s2 = await db
        .collection("users")
        .where("teamIds", "array-contains", thread.teamId)
        .get();
      s2.forEach((d) => {
        const u = d.data() as UserDoc;
        const id = u.uid || d.id;
        if (id) uids.add(id);
      });
    } catch (err) {
      logger.warn("team lookup failed", {threadId: thread.id, err});
    }
    return Array.from(uids);
  }

  return thread.participants || [];
}

/** Truncate a push body to FCM's safe envelope size. */
function truncate(s: string, max: number): string {
  if (!s) return s;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export const onChatMessageCreate = onDocumentCreated(
  "chat_messages/{messageId}",
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const messageId = event.params.messageId;
    const message = snap.data() as ChatMessage | undefined;
    if (!message) return;
    if (message._skipPush === true) {
      logger.info("skip-push flag set", {messageId});
      return;
    }
    if (!message.senderId || !message.threadId) {
      logger.warn("missing sender or thread", {messageId});
      return;
    }

    const db = getFirestore();
    const threadRef = db.collection("chat_threads").doc(message.threadId);
    const threadSnap = await threadRef.get();
    if (!threadSnap.exists) {
      logger.warn("thread not found", {threadId: message.threadId});
      return;
    }
    const thread = {id: threadSnap.id, ...threadSnap.data()} as ChatThread;

    // Same demo-team kill switch as onEventCreate. Threads on a
    // demo/notifications-off team never fan out, even if stale
    // team memberships would otherwise resolve real users.
    //
    // Groups post-2026-07-21 carry teamId='' at rest (privacy fix)
    // so the check falls back to originTeamId, the team the coach
    // was viewing when they spun the group up. Without this fallback
    // a demo-team coach's group pushes would escape the team-level
    // kill switch.
    const threadTeamId = thread.teamId || thread.originTeamId || "";
    if (threadTeamId) {
      try {
        const teamSnap = await db.collection("teams").doc(threadTeamId).get();
        if (teamSnap.exists) {
          const t = teamSnap.data() as {
            isDemo?: boolean;
            notificationsDisabled?: boolean;
          };
          if (t.isDemo === true || t.notificationsDisabled === true) {
            logger.info("chat push skipped — team demo/notifications-off", {
              messageId, threadId: message.threadId, teamId: threadTeamId,
            });
            return;
          }
        }
      } catch (err) {
        logger.warn("team demo-flag lookup failed", {teamId: threadTeamId, err});
      }
    }

    const candidateUids = await resolveRecipientUids(thread);
    const mutedThreadSet = new Set<string>(thread.mutedByUids || []);
    const recipients = candidateUids.filter(
      (uid) =>
        !!uid &&
        uid !== message.senderId &&
        !mutedThreadSet.has(uid),
    );

    if (recipients.length === 0) {
      logger.info("no recipients", {messageId, threadId: message.threadId});
      await db.collection("push_attempts").doc(messageId).set({
        messageId,
        threadId: message.threadId,
        senderId: message.senderId,
        kind: "chat",
        sent: 0,
        failed: 0,
        recipientCount: 0,
        recipientsWithoutTokens: 0,
        recipientsWithPrefOff: 0,
        recipientsWhoMutedSender: 0,
        createdAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    // Per-recipient counters so the attempt log can answer "why didn't X
    // get this push" without us guessing.
    let recipientsWithoutTokens = 0;
    let recipientsWithPrefOff = 0;
    let recipientsWhoMutedSender = 0;
    const tokenToUid = new Map<string, string>();
    const tokens: string[] = [];

    for (const uid of recipients) {
      try {
        const uSnap = await db.collection("users").doc(uid).get();
        if (!uSnap.exists) continue;
        const u = uSnap.data() as UserDoc;
        if (u.isActive === false) continue;
        const chatOn = u.pushPreferences?.chat !== false; // default-on
        if (!chatOn) {
          recipientsWithPrefOff++;
          continue;
        }
        if (
          Array.isArray(u.mutedUserIds) &&
          u.mutedUserIds.includes(message.senderId)
        ) {
          recipientsWhoMutedSender++;
          continue;
        }
        const arr = Array.isArray(u.fcmTokens) ? u.fcmTokens : [];
        const live = arr.filter(
          (t): t is string => typeof t === "string" && t.length > 10,
        );
        if (live.length === 0) {
          recipientsWithoutTokens++;
          continue;
        }
        for (const t of live) {
          if (!tokenToUid.has(t)) {
            tokenToUid.set(t, uid);
            tokens.push(t);
          }
        }
      } catch (err) {
        logger.warn("recipient read failed", {uid, err});
      }
    }

    if (tokens.length === 0) {
      await db.collection("push_attempts").doc(messageId).set({
        messageId,
        threadId: message.threadId,
        senderId: message.senderId,
        kind: "chat",
        sent: 0,
        failed: 0,
        recipientCount: recipients.length,
        recipientsWithoutTokens,
        recipientsWithPrefOff,
        recipientsWhoMutedSender,
        createdAt: FieldValue.serverTimestamp(),
      });
      logger.info("no live tokens after filtering", {
        messageId,
        recipientCount: recipients.length,
      });
      return;
    }

    const isDM = thread.isDM === true;
    const senderName = message.senderName || "Someone";
    const pushTitle = isDM
      ? `${senderName} (DM)`
      : `${senderName} in ${thread.title || "your team"}`;
    const attachCount = Array.isArray(message.attachments)
      ? message.attachments.length
      : 0;
    const pushBody = message.content
      ? truncate(message.content, 140)
      : attachCount > 0
        ? `Sent ${attachCount} photo${attachCount > 1 ? "s" : ""}`
        : "New message";
    const deepLinkPath = `/chat?thread=${message.threadId}&message=${messageId}`;
    const deepLink = `${APP_ORIGIN}${deepLinkPath}`;

    // sendEachForMulticast handles >500 tokens by chunking internally —
    // not that we expect to hit that ceiling for chat any time soon.
    const response = await getMessaging().sendEachForMulticast({
      tokens,
      notification: {
        title: pushTitle,
        body: pushBody,
      },
      data: {
        url: deepLink,
        path: deepLinkPath,
        threadId: message.threadId,
        messageId,
        kind: "chat",
      },
      webpush: {
        fcmOptions: {link: deepLink},
        notification: {icon: "/images/logo.png"},
      },
      apns: {
        payload: {
          aps: {
            sound: "default",
            badge: undefined,
          },
        },
      },
      android: {
        priority: "high",
        notification: {
          sound: "default",
          channelId: "default",
        },
      },
    });

    // Pull dead tokens out of every user doc that held them so we stop
    // hammering FCM with known-bad tokens. UNREGISTERED / NOT_FOUND /
    // INVALID_ARGUMENT-for-token are the canonical "device gone" codes.
    const deadTokens: string[] = [];
    response.responses.forEach((r, i) => {
      if (r.success) return;
      const code = r.error?.code || "";
      if (
        code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token" ||
        code === "messaging/invalid-argument"
      ) {
        deadTokens.push(tokens[i]);
      }
    });

    if (deadTokens.length > 0) {
      const uidToDead = new Map<string, string[]>();
      for (const t of deadTokens) {
        const uid = tokenToUid.get(t);
        if (!uid) continue;
        if (!uidToDead.has(uid)) uidToDead.set(uid, []);
        uidToDead.get(uid)!.push(t);
      }
      const batch = db.batch();
      for (const [uid, deadForUser] of uidToDead) {
        batch.update(db.collection("users").doc(uid), {
          fcmTokens: FieldValue.arrayRemove(...deadForUser),
        });
      }
      try {
        await batch.commit();
        logger.info("pruned dead tokens", {count: deadTokens.length});
      } catch (err) {
        logger.warn("dead-token prune failed", {err});
      }
    }

    await db.collection("push_attempts").doc(messageId).set({
      messageId,
      threadId: message.threadId,
      senderId: message.senderId,
      kind: "chat",
      sent: response.successCount,
      failed: response.failureCount,
      deadTokensRemoved: deadTokens.length,
      recipientCount: recipients.length,
      recipientsWithoutTokens,
      recipientsWithPrefOff,
      recipientsWhoMutedSender,
      tokensTargeted: tokens.length,
      createdAt: FieldValue.serverTimestamp(),
    });

    logger.info("chat push fan-out complete", {
      messageId,
      sent: response.successCount,
      failed: response.failureCount,
      recipientCount: recipients.length,
    });
  },
);

// ───────────────────────────────────────────────────────────────────
// Events fan-out
// ───────────────────────────────────────────────────────────────────

interface EventDoc {
  id?: string;
  teamId?: string;
  title?: string;
  type?: "game" | "practice" | "event" | string;
  date?: FirebaseFirestore.Timestamp | Date;
  location?: string;
  createdBy?: string;
  /** Coach opt-in: when true, the trigger fans push to the team. When
   *  false/undefined the trigger no-ops. EventForm sets this based on
   *  the "Notify team" checkbox. */
  notifyOnCreate?: boolean;
}

/**
 * Fan-out push notifications for newly created events. Replaces the
 * client-side sendPushToTeam call in EventForm.tsx — that path stays
 * live as a safety net for the first week so we can compare against
 * push_attempts before deleting it.
 *
 * Same shape as onChatMessageCreate: resolve team roster fresh from
 * users (NOT a stale participants array), filter by pushPreferences.events,
 * collect tokens, sendEachForMulticast, prune dead tokens, write
 * /push_attempts/{eventId} with the delivery counts.
 */
export const onEventCreate = onDocumentCreated(
  "events/{eventId}",
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const eventId = event.params.eventId;
    const eventDoc = snap.data() as EventDoc | undefined;
    if (!eventDoc) return;
    if (!eventDoc.notifyOnCreate) {
      logger.info("event push skipped — notifyOnCreate not set", {eventId});
      return;
    }
    if (!eventDoc.teamId) {
      logger.warn("event push skipped — no teamId", {eventId});
      return;
    }

    const db = getFirestore();
    const teamId = eventDoc.teamId;

    // Kill switch: teams flagged as demo/screenshot content, or
    // explicitly opted out of push, never fan out. Prevents the
    // 2026-07-01 leak where an event created on a demo team pushed
    // a notification to a real user whose account still had the
    // demo team in `teamIds` (stale membership from initial setup).
    // Marking the team doc with either flag stops the fan-out
    // regardless of who still touches the team's memberships.
    try {
      const teamSnap = await db.collection("teams").doc(teamId).get();
      if (teamSnap.exists) {
        const t = teamSnap.data() as {
          isDemo?: boolean;
          notificationsDisabled?: boolean;
        };
        if (t.isDemo === true || t.notificationsDisabled === true) {
          logger.info("event push skipped — team demo/notifications-off", {
            eventId, teamId,
          });
          return;
        }
      }
    } catch (err) {
      logger.warn("team demo-flag lookup failed", {teamId, err});
    }

    // Resolve team roster — same two-path lookup as the chat trigger.
    const candidateUids = new Set<string>();
    try {
      const s1 = await db.collection("users").where("teamId", "==", teamId).get();
      s1.forEach((d) => {
        const u = d.data() as UserDoc;
        const id = u.uid || d.id;
        if (id) candidateUids.add(id);
      });
      const s2 = await db
        .collection("users")
        .where("teamIds", "array-contains", teamId)
        .get();
      s2.forEach((d) => {
        const u = d.data() as UserDoc;
        const id = u.uid || d.id;
        if (id) candidateUids.add(id);
      });
    } catch (err) {
      logger.warn("team lookup failed", {teamId, err});
    }

    const senderUid = eventDoc.createdBy;
    const recipients = Array.from(candidateUids).filter(
      (uid) => uid && uid !== senderUid,
    );

    if (recipients.length === 0) {
      await db.collection("push_attempts").doc(eventId).set({
        eventId,
        teamId,
        senderId: senderUid || null,
        kind: "event",
        sent: 0,
        failed: 0,
        recipientCount: 0,
        recipientsWithoutTokens: 0,
        recipientsWithPrefOff: 0,
        createdAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    let recipientsWithoutTokens = 0;
    let recipientsWithPrefOff = 0;
    const tokenToUid = new Map<string, string>();
    const tokens: string[] = [];

    for (const uid of recipients) {
      try {
        const uSnap = await db.collection("users").doc(uid).get();
        if (!uSnap.exists) continue;
        const u = uSnap.data() as UserDoc;
        if (u.isActive === false) continue;
        const eventsOn = u.pushPreferences?.events !== false; // default-on
        if (!eventsOn) {
          recipientsWithPrefOff++;
          continue;
        }
        const arr = Array.isArray(u.fcmTokens) ? u.fcmTokens : [];
        const live = arr.filter(
          (t): t is string => typeof t === "string" && t.length > 10,
        );
        if (live.length === 0) {
          recipientsWithoutTokens++;
          continue;
        }
        for (const t of live) {
          if (!tokenToUid.has(t)) {
            tokenToUid.set(t, uid);
            tokens.push(t);
          }
        }
      } catch (err) {
        logger.warn("recipient read failed", {uid, err});
      }
    }

    if (tokens.length === 0) {
      await db.collection("push_attempts").doc(eventId).set({
        eventId,
        teamId,
        senderId: senderUid || null,
        kind: "event",
        sent: 0,
        failed: 0,
        recipientCount: recipients.length,
        recipientsWithoutTokens,
        recipientsWithPrefOff,
        createdAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    const type = eventDoc.type || "event";
    const typeLabel = type === "game" ? "New game" : type === "practice" ? "New practice" : "New event";
    const title = `${typeLabel}: ${eventDoc.title || "(untitled)"}`;
    let whenStr = "";
    const ts = eventDoc.date;
    const when = ts instanceof Date ? ts : (ts && typeof (ts as any).toDate === "function" ? (ts as any).toDate() : null);
    if (when) {
      whenStr = when.toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    }
    const body = [whenStr, eventDoc.location].filter(Boolean).join(" · ") || "Tap for details";
    const deepLinkPath = `/events/${eventId}`;
    const deepLink = `${APP_ORIGIN}${deepLinkPath}`;

    const response = await getMessaging().sendEachForMulticast({
      tokens,
      notification: {title, body},
      data: {url: deepLink, path: deepLinkPath, eventId, kind: "event"},
      webpush: {
        fcmOptions: {link: deepLink},
        notification: {icon: "/images/logo.png"},
      },
      apns: {payload: {aps: {sound: "default"}}},
      android: {priority: "high", notification: {sound: "default", channelId: "default"}},
    });

    // Prune dead tokens — identical pattern to chat.
    const deadTokens: string[] = [];
    response.responses.forEach((r, i) => {
      if (r.success) return;
      const code = r.error?.code || "";
      if (
        code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token" ||
        code === "messaging/invalid-argument"
      ) {
        deadTokens.push(tokens[i]);
      }
    });
    if (deadTokens.length > 0) {
      const uidToDead = new Map<string, string[]>();
      for (const t of deadTokens) {
        const uid = tokenToUid.get(t);
        if (!uid) continue;
        if (!uidToDead.has(uid)) uidToDead.set(uid, []);
        uidToDead.get(uid)!.push(t);
      }
      const batch = db.batch();
      for (const [uid, deadForUser] of uidToDead) {
        batch.update(db.collection("users").doc(uid), {
          fcmTokens: FieldValue.arrayRemove(...deadForUser),
        });
      }
      try {
        await batch.commit();
      } catch (err) {
        logger.warn("dead-token prune failed", {err});
      }
    }

    await db.collection("push_attempts").doc(eventId).set({
      eventId,
      teamId,
      senderId: senderUid || null,
      kind: "event",
      sent: response.successCount,
      failed: response.failureCount,
      deadTokensRemoved: deadTokens.length,
      recipientCount: recipients.length,
      recipientsWithoutTokens,
      recipientsWithPrefOff,
      tokensTargeted: tokens.length,
      createdAt: FieldValue.serverTimestamp(),
    });

    logger.info("event push fan-out complete", {
      eventId,
      teamId,
      sent: response.successCount,
      failed: response.failureCount,
    });
  },
);

// ───────────────────────────────────────────────────────────────────
// Helpdesk reply fan-out
// ───────────────────────────────────────────────────────────────────

interface HelpdeskCommentDoc {
  ticketId?: string;
  authorId?: string;
  authorName?: string;
  content?: string;
  /** Only set on real user replies. System comments (status changes,
   *  assignment audits) omit this so we don't fire a notification
   *  for "Status changed: open → assigned." */
  notify?: boolean;
}

interface HelpdeskTicketDoc {
  subject?: string;
  createdBy?: string;
  assignedTo?: string;
  clubId?: string;
}

/**
 * Fan-out helpdesk replies. Triggered when a user posts a real comment
 * to a ticket (system comments skip via the `notify` flag). Recipients
 * are the ticket creator + assignee + every club admin, minus the
 * comment author. Filtered by pushPreferences.helpdesk.
 *
 * Replaces the client-side notifyReply() call in HelpdeskTicket.tsx.
 * That path stays live as a safety net for the first week.
 */
export const onHelpdeskCommentCreate = onDocumentCreated(
  "helpdeskComments/{commentId}",
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const commentId = event.params.commentId;
    const comment = snap.data() as HelpdeskCommentDoc | undefined;
    if (!comment) return;
    if (!comment.notify) {
      logger.info("helpdesk comment skip — no notify flag", {commentId});
      return;
    }
    if (!comment.ticketId || !comment.authorId) return;

    const db = getFirestore();
    const ticketSnap = await db.collection("helpdeskTickets").doc(comment.ticketId).get();
    if (!ticketSnap.exists) {
      logger.warn("helpdesk ticket not found", {ticketId: comment.ticketId});
      return;
    }
    const ticket = ticketSnap.data() as HelpdeskTicketDoc;

    // Gather recipients: creator + assignee + every club admin. We do
    // the admin lookup with isClubAdmin == true, matching the client's
    // existing query.
    const recipientSet = new Set<string>();
    if (ticket.createdBy) recipientSet.add(ticket.createdBy);
    if (ticket.assignedTo) recipientSet.add(ticket.assignedTo);
    try {
      const adminSnap = await db
        .collection("users")
        .where("isClubAdmin", "==", true)
        .get();
      adminSnap.forEach((d) => recipientSet.add(d.id));
    } catch (err) {
      logger.warn("admin lookup failed", {err});
    }
    recipientSet.delete(comment.authorId);
    const recipients = Array.from(recipientSet);

    if (recipients.length === 0) {
      await db.collection("push_attempts").doc(commentId).set({
        commentId,
        ticketId: comment.ticketId,
        senderId: comment.authorId,
        kind: "helpdesk_comment",
        sent: 0,
        failed: 0,
        recipientCount: 0,
        recipientsWithoutTokens: 0,
        recipientsWithPrefOff: 0,
        createdAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    let recipientsWithoutTokens = 0;
    let recipientsWithPrefOff = 0;
    const tokenToUid = new Map<string, string>();
    const tokens: string[] = [];

    for (const uid of recipients) {
      try {
        const uSnap = await db.collection("users").doc(uid).get();
        if (!uSnap.exists) continue;
        const u = uSnap.data() as UserDoc;
        if (u.isActive === false) continue;
        const on = u.pushPreferences?.helpdesk !== false; // default-on
        if (!on) {
          recipientsWithPrefOff++;
          continue;
        }
        const arr = Array.isArray(u.fcmTokens) ? u.fcmTokens : [];
        const live = arr.filter(
          (t): t is string => typeof t === "string" && t.length > 10,
        );
        if (live.length === 0) {
          recipientsWithoutTokens++;
          continue;
        }
        for (const t of live) {
          if (!tokenToUid.has(t)) {
            tokenToUid.set(t, uid);
            tokens.push(t);
          }
        }
      } catch (err) {
        logger.warn("recipient read failed", {uid, err});
      }
    }

    if (tokens.length === 0) {
      await db.collection("push_attempts").doc(commentId).set({
        commentId,
        ticketId: comment.ticketId,
        senderId: comment.authorId,
        kind: "helpdesk_comment",
        sent: 0,
        failed: 0,
        recipientCount: recipients.length,
        recipientsWithoutTokens,
        recipientsWithPrefOff,
        createdAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    const subject = ticket.subject || "Support";
    const author = comment.authorName || "Someone";
    const preview = (comment.content || "").length > 120
      ? `${(comment.content || "").slice(0, 117)}…`
      : (comment.content || "");
    const deepLinkPath = `/helpdesk/${comment.ticketId}`;
    const deepLink = `${APP_ORIGIN}${deepLinkPath}`;

    const response = await getMessaging().sendEachForMulticast({
      tokens,
      notification: {
        title: `Support: ${subject}`,
        body: `${author}: ${preview}`,
      },
      data: {url: deepLink, path: deepLinkPath, ticketId: comment.ticketId, kind: "helpdesk_comment"},
      webpush: {fcmOptions: {link: deepLink}, notification: {icon: "/images/logo.png"}},
      apns: {payload: {aps: {sound: "default"}}},
      android: {priority: "high", notification: {sound: "default", channelId: "default"}},
    });

    const deadTokens: string[] = [];
    response.responses.forEach((r, i) => {
      if (r.success) return;
      const code = r.error?.code || "";
      if (
        code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token" ||
        code === "messaging/invalid-argument"
      ) {
        deadTokens.push(tokens[i]);
      }
    });
    if (deadTokens.length > 0) {
      const uidToDead = new Map<string, string[]>();
      for (const t of deadTokens) {
        const uid = tokenToUid.get(t);
        if (!uid) continue;
        if (!uidToDead.has(uid)) uidToDead.set(uid, []);
        uidToDead.get(uid)!.push(t);
      }
      const batch = db.batch();
      for (const [uid, deadForUser] of uidToDead) {
        batch.update(db.collection("users").doc(uid), {
          fcmTokens: FieldValue.arrayRemove(...deadForUser),
        });
      }
      try {
        await batch.commit();
      } catch (err) {
        logger.warn("dead-token prune failed", {err});
      }
    }

    await db.collection("push_attempts").doc(commentId).set({
      commentId,
      ticketId: comment.ticketId,
      senderId: comment.authorId,
      kind: "helpdesk_comment",
      sent: response.successCount,
      failed: response.failureCount,
      deadTokensRemoved: deadTokens.length,
      recipientCount: recipients.length,
      recipientsWithoutTokens,
      recipientsWithPrefOff,
      tokensTargeted: tokens.length,
      createdAt: FieldValue.serverTimestamp(),
    });

    logger.info("helpdesk push fan-out complete", {
      commentId,
      ticketId: comment.ticketId,
      sent: response.successCount,
      failed: response.failureCount,
    });
  },
);
