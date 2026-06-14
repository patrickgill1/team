// Chat send queue with auto-retry on network restore.
//
// A send can fail for three reasons:
//   1. User is offline (most common on cellular dead zones)
//   2. Transient Firestore error (server hiccup, retry should succeed)
//   3. Permanent error (rule denial, malformed data — retry won't help)
//
// The queue gives every send a stable id, retries with exponential
// backoff while online, and reattempts the queue whenever the browser
// fires an online event. Idempotent writes (client-id setDoc) make
// retries safe — a duplicate write is a no-op rather than two copies.
//
// In-memory only by design: we DO survive transient drops within a
// session, but we don't persist across app restarts because Firestore's
// own offline persistence already covers that case (queued writes get
// flushed when the SDK reconnects).

import { logFirestoreError } from './firestoreLogger';

export interface QueuedSend {
  id: string;
  threadId: string;
  attempt: number;
  lastError?: string;
  do: () => Promise<void>;
  onSuccess?: () => void;
  onFinalFailure?: (err: unknown) => void;
}

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 800; // first retry waits ~800ms, then 1.6s, 3.2s…

class ChatSendQueue {
  private queue: QueuedSend[] = [];
  private flushing = false;
  private retryTimers = new Map<string, number>();

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        // Network came back — try every queued item once immediately.
        void this.flush();
      });
    }
  }

  /** Enqueue a send. If currently online, attempts immediately;
   *  otherwise waits for the next online event. */
  enqueue(item: QueuedSend): void {
    // Replace any existing item with the same id (idempotent: caller
    // might re-enqueue while we're retrying).
    this.queue = this.queue.filter(q => q.id !== item.id);
    this.queue.push(item);
    void this.attempt(item);
  }

  /** Force a retry of every queued item. Called on online + manual. */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const snapshot = [...this.queue];
      for (const item of snapshot) {
        await this.attempt(item);
      }
    } finally {
      this.flushing = false;
    }
  }

  private async attempt(item: QueuedSend): Promise<void> {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      // Offline — leave in queue, online listener will pick it up.
      return;
    }
    try {
      await item.do();
      this.queue = this.queue.filter(q => q.id !== item.id);
      const timer = this.retryTimers.get(item.id);
      if (timer) { window.clearTimeout(timer); this.retryTimers.delete(item.id); }
      item.onSuccess?.();
    } catch (err) {
      item.attempt += 1;
      item.lastError = (err as any)?.message || String(err);
      logFirestoreError('queued-send', `chat_messages/${item.id}`, err, { attempt: item.attempt, threadId: item.threadId });
      if (item.attempt >= MAX_ATTEMPTS) {
        this.queue = this.queue.filter(q => q.id !== item.id);
        item.onFinalFailure?.(err);
        return;
      }
      // Exponential backoff retry.
      const delay = BASE_BACKOFF_MS * Math.pow(2, item.attempt - 1);
      const existingTimer = this.retryTimers.get(item.id);
      if (existingTimer) window.clearTimeout(existingTimer);
      const t = window.setTimeout(() => {
        this.retryTimers.delete(item.id);
        void this.attempt(item);
      }, delay);
      this.retryTimers.set(item.id, t);
    }
  }

  /** Active queue length — useful for a UI offline-pending badge. */
  size(): number { return this.queue.length; }

  /** Inspect items still pending for a specific thread. */
  pendingForThread(threadId: string): QueuedSend[] {
    return this.queue.filter(q => q.threadId === threadId);
  }
}

export const chatSendQueue = new ChatSendQueue();
