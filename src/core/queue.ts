import { createLogger } from '../utils/logger.js';
import type { InboundMessage } from '../channels/types.js';

const logger = createLogger('queue');

/** Default debounce interval in ms. */
const DEFAULT_DEBOUNCE_MS = 800;

/** Max concurrent message processing slots. */
const MAX_CONCURRENT = 10;

export type QueueMode = 'followup' | 'steer' | 'interrupt';

/**
 * A pending message entry waiting to be processed.
 */
interface QueueEntry {
  message: InboundMessage;
  resolve: (value: void) => void;
  reject: (reason: unknown) => void;
}

/**
 * Per-session queue state.
 */
interface SessionQueue {
  /** Messages waiting to be dispatched. */
  pending: QueueEntry[];
  /** Whether this session currently has an active processing call. */
  processing: boolean;
  /** Debounce timer for batching rapid messages. */
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** Accumulated messages during debounce window. */
  debounceBuffer: InboundMessage[];
  /** AbortController for the current processing task (used by interrupt mode). */
  abortController: AbortController | null;
}

export interface QueueConfig {
  mode?: QueueMode;
  debounceMs?: number;
}

/**
 * Handler function that processes a batch of messages for a session.
 * The batch contains one or more messages that were debounced together.
 * The AbortSignal may be used to cancel processing (interrupt mode).
 */
export type MessageHandler = (
  messages: InboundMessage[],
  signal: AbortSignal,
) => Promise<void>;

/**
 * MessageQueue manages per-session message queuing with debounce and
 * three queue modes: followup, steer, and interrupt.
 *
 * - followup: new messages queue behind the current processing task.
 * - steer: new messages replace any pending (not yet processing) messages.
 * - interrupt: cancel the current processing task and queue the new message.
 *
 * Debounce (default 800ms) batches rapid consecutive messages before dispatch.
 * Global concurrency is capped at MAX_CONCURRENT (10).
 */
export class MessageQueue {
  private readonly mode: QueueMode;
  private readonly debounceMs: number;
  private readonly queues: Map<string, SessionQueue> = new Map();
  private handler: MessageHandler | null = null;
  private activeConcurrent = 0;
  private readonly waitingForSlot: Array<() => void> = [];

  constructor(config?: QueueConfig) {
    this.mode = config?.mode ?? 'followup';
    this.debounceMs = config?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /**
   * Register the handler that will process messages.
   */
  onProcess(handler: MessageHandler): void {
    this.handler = handler;
  }

  /**
   * Enqueue a message for processing. Returns a promise that resolves
   * when the message has been fully processed.
   */
  async enqueue(sessionKey: string, message: InboundMessage): Promise<void> {
    const queue = this.getOrCreateQueue(sessionKey);

    if (this.mode === 'interrupt' && queue.processing) {
      // Cancel current processing
      if (queue.abortController) {
        queue.abortController.abort();
        logger.info(`Interrupted current processing for session: ${sessionKey}`);
      }
    }

    if (this.mode === 'steer' && queue.pending.length > 0) {
      // Replace all pending messages with this new one
      for (const entry of queue.pending) {
        entry.resolve();
      }
      queue.pending = [];
      logger.debug(`Replaced pending messages for session: ${sessionKey}`);
    }

    return new Promise<void>((resolve, reject) => {
      // Add to debounce buffer
      queue.debounceBuffer.push(message);

      // Reset debounce timer
      if (queue.debounceTimer !== null) {
        clearTimeout(queue.debounceTimer);
      }

      queue.debounceTimer = setTimeout(() => {
        queue.debounceTimer = null;

        // Flush debounce buffer into a single queue entry
        const batch = queue.debounceBuffer.splice(0);
        if (batch.length === 0) {
          resolve();
          return;
        }

        // Use the last message as the representative entry
        const entry: QueueEntry = {
          message: batch[batch.length - 1]!,
          resolve,
          reject,
        };

        // Store all batched messages on the entry for handler
        (entry as QueueEntry & { batch?: InboundMessage[] }).batch = batch;

        queue.pending.push(entry);
        this.drain(sessionKey);
      }, this.debounceMs);
    });
  }

  /**
   * Get current stats for observability.
   */
  stats(): { activeConcurrent: number; sessionCount: number } {
    return {
      activeConcurrent: this.activeConcurrent,
      sessionCount: this.queues.size,
    };
  }

  /**
   * Dispose all timers and abort all processing.
   */
  dispose(): void {
    for (const [, queue] of this.queues) {
      if (queue.debounceTimer !== null) {
        clearTimeout(queue.debounceTimer);
      }
      if (queue.abortController) {
        queue.abortController.abort();
      }
      for (const entry of queue.pending) {
        entry.resolve();
      }
    }
    this.queues.clear();
  }

  // ---- Private helpers ----

  private getOrCreateQueue(sessionKey: string): SessionQueue {
    let queue = this.queues.get(sessionKey);
    if (!queue) {
      queue = {
        pending: [],
        processing: false,
        debounceTimer: null,
        debounceBuffer: [],
        abortController: null,
      };
      this.queues.set(sessionKey, queue);
    }
    return queue;
  }

  private drain(sessionKey: string): void {
    const queue = this.queues.get(sessionKey);
    if (!queue || queue.processing || queue.pending.length === 0) {
      return;
    }

    // Check global concurrency limit
    if (this.activeConcurrent >= MAX_CONCURRENT) {
      // Wait for a slot to open
      this.waitingForSlot.push(() => this.drain(sessionKey));
      return;
    }

    const entry = queue.pending.shift()!;
    const batch = (entry as QueueEntry & { batch?: InboundMessage[] }).batch ?? [entry.message];

    queue.processing = true;
    queue.abortController = new AbortController();
    this.activeConcurrent++;

    this.processEntry(sessionKey, queue, batch, entry)
      .catch((err) => {
        logger.error(`Queue processing error for ${sessionKey}: ${String(err)}`);
      });
  }

  private async processEntry(
    sessionKey: string,
    queue: SessionQueue,
    batch: InboundMessage[],
    entry: QueueEntry,
  ): Promise<void> {
    try {
      if (!this.handler) {
        logger.warn('No message handler registered');
        entry.resolve();
        return;
      }

      await this.handler(batch, queue.abortController!.signal);
      entry.resolve();
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        logger.debug(`Processing aborted for session: ${sessionKey}`);
        entry.resolve();
      } else {
        entry.reject(err);
      }
    } finally {
      queue.processing = false;
      queue.abortController = null;
      this.activeConcurrent--;

      // Release a waiting drain call if any
      const next = this.waitingForSlot.shift();
      if (next) {
        next();
      }

      // Continue draining this session's queue
      this.drain(sessionKey);

      // Clean up empty queues
      if (queue.pending.length === 0 && !queue.processing && queue.debounceBuffer.length === 0) {
        this.queues.delete(sessionKey);
      }
    }
  }
}
