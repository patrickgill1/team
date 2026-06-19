"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.onChatMessageCreate = void 0;
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
const firestore_1 = require("firebase-functions/v2/firestore");
const v2_1 = require("firebase-functions/v2");
const firebase_functions_1 = require("firebase-functions");
const app_1 = require("firebase-admin/app");
const firestore_2 = require("firebase-admin/firestore");
const messaging_1 = require("firebase-admin/messaging");
(0, app_1.initializeApp)();
// us-central1 keeps things colocated with the default Firestore region.
// Concurrency=80 means one warm container handles up to 80 concurrent
// messages — Patrick's whole club fits in one container's worth of load.
(0, v2_1.setGlobalOptions)({
    region: "us-central1",
    maxInstances: 10,
    concurrency: 80,
});
const APP_ORIGIN = process.env.APP_ORIGIN || "https://goalkickr.com";
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
async function resolveRecipientUids(thread) {
    const isDM = thread.isDM === true;
    const isGroup = thread.isGroup === true;
    const scope = thread.scope || "team";
    if (isDM || isGroup)
        return thread.participants || [];
    if (scope === "team" && thread.teamId) {
        const db = (0, firestore_2.getFirestore)();
        // Match the client's two-path team lookup: legacy `teamId == X`
        // for single-team users, plus `teamIds array-contains X` for the
        // newer multi-team model.
        const uids = new Set();
        try {
            const s1 = await db
                .collection("users")
                .where("teamId", "==", thread.teamId)
                .get();
            s1.forEach((d) => {
                const u = d.data();
                const id = u.uid || d.id;
                if (id)
                    uids.add(id);
            });
            const s2 = await db
                .collection("users")
                .where("teamIds", "array-contains", thread.teamId)
                .get();
            s2.forEach((d) => {
                const u = d.data();
                const id = u.uid || d.id;
                if (id)
                    uids.add(id);
            });
        }
        catch (err) {
            firebase_functions_1.logger.warn("team lookup failed", { threadId: thread.id, err });
        }
        return Array.from(uids);
    }
    return thread.participants || [];
}
/** Truncate a push body to FCM's safe envelope size. */
function truncate(s, max) {
    if (!s)
        return s;
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
exports.onChatMessageCreate = (0, firestore_1.onDocumentCreated)("chat_messages/{messageId}", async (event) => {
    const snap = event.data;
    if (!snap)
        return;
    const messageId = event.params.messageId;
    const message = snap.data();
    if (!message)
        return;
    if (message._skipPush === true) {
        firebase_functions_1.logger.info("skip-push flag set", { messageId });
        return;
    }
    if (!message.senderId || !message.threadId) {
        firebase_functions_1.logger.warn("missing sender or thread", { messageId });
        return;
    }
    const db = (0, firestore_2.getFirestore)();
    const threadRef = db.collection("chat_threads").doc(message.threadId);
    const threadSnap = await threadRef.get();
    if (!threadSnap.exists) {
        firebase_functions_1.logger.warn("thread not found", { threadId: message.threadId });
        return;
    }
    const thread = { id: threadSnap.id, ...threadSnap.data() };
    const candidateUids = await resolveRecipientUids(thread);
    const mutedThreadSet = new Set(thread.mutedByUids || []);
    const recipients = candidateUids.filter((uid) => !!uid &&
        uid !== message.senderId &&
        !mutedThreadSet.has(uid));
    if (recipients.length === 0) {
        firebase_functions_1.logger.info("no recipients", { messageId, threadId: message.threadId });
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
            createdAt: firestore_2.FieldValue.serverTimestamp(),
        });
        return;
    }
    // Per-recipient counters so the attempt log can answer "why didn't X
    // get this push" without us guessing.
    let recipientsWithoutTokens = 0;
    let recipientsWithPrefOff = 0;
    let recipientsWhoMutedSender = 0;
    const tokenToUid = new Map();
    const tokens = [];
    for (const uid of recipients) {
        try {
            const uSnap = await db.collection("users").doc(uid).get();
            if (!uSnap.exists)
                continue;
            const u = uSnap.data();
            if (u.isActive === false)
                continue;
            const chatOn = u.pushPreferences?.chat !== false; // default-on
            if (!chatOn) {
                recipientsWithPrefOff++;
                continue;
            }
            if (Array.isArray(u.mutedUserIds) &&
                u.mutedUserIds.includes(message.senderId)) {
                recipientsWhoMutedSender++;
                continue;
            }
            const arr = Array.isArray(u.fcmTokens) ? u.fcmTokens : [];
            const live = arr.filter((t) => typeof t === "string" && t.length > 10);
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
        }
        catch (err) {
            firebase_functions_1.logger.warn("recipient read failed", { uid, err });
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
            createdAt: firestore_2.FieldValue.serverTimestamp(),
        });
        firebase_functions_1.logger.info("no live tokens after filtering", {
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
    const response = await (0, messaging_1.getMessaging)().sendEachForMulticast({
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
            fcmOptions: { link: deepLink },
            notification: { icon: "/images/logo.png" },
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
    const deadTokens = [];
    response.responses.forEach((r, i) => {
        if (r.success)
            return;
        const code = r.error?.code || "";
        if (code === "messaging/registration-token-not-registered" ||
            code === "messaging/invalid-registration-token" ||
            code === "messaging/invalid-argument") {
            deadTokens.push(tokens[i]);
        }
    });
    if (deadTokens.length > 0) {
        const uidToDead = new Map();
        for (const t of deadTokens) {
            const uid = tokenToUid.get(t);
            if (!uid)
                continue;
            if (!uidToDead.has(uid))
                uidToDead.set(uid, []);
            uidToDead.get(uid).push(t);
        }
        const batch = db.batch();
        for (const [uid, deadForUser] of uidToDead) {
            batch.update(db.collection("users").doc(uid), {
                fcmTokens: firestore_2.FieldValue.arrayRemove(...deadForUser),
            });
        }
        try {
            await batch.commit();
            firebase_functions_1.logger.info("pruned dead tokens", { count: deadTokens.length });
        }
        catch (err) {
            firebase_functions_1.logger.warn("dead-token prune failed", { err });
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
        createdAt: firestore_2.FieldValue.serverTimestamp(),
    });
    firebase_functions_1.logger.info("chat push fan-out complete", {
        messageId,
        sent: response.successCount,
        failed: response.failureCount,
        recipientCount: recipients.length,
    });
});
//# sourceMappingURL=index.js.map