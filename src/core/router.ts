import { createLogger } from '../utils/logger.js';
import type { InboundMessage } from '../channels/types.js';
import type { BindingConfig, AppConfig } from './config.js';
import { SessionManager } from './session.js';
import { MessageQueue } from './queue.js';
import type { MessageHandler } from './queue.js';

const logger = createLogger('router');

/** Dedup TTL: 5 minutes in milliseconds. */
const DEDUP_TTL_MS = 5 * 60 * 1000;

/** Cleanup interval for expired dedup entries. */
const DEDUP_CLEANUP_INTERVAL_MS = 60 * 1000;

/**
 * Result of routing a message: which agent should handle it.
 */
export interface RouteResult {
  agentId: string;
  sessionKey: string;
  binding: BindingConfig;
}

/**
 * Callback invoked when a routed message (or batch) is ready for processing.
 */
export type RouteHandler = (
  route: RouteResult,
  messages: InboundMessage[],
  signal: AbortSignal,
) => Promise<void>;

/**
 * MessageRouter handles:
 * - Message deduplication (by message_id, 5min TTL)
 * - @mention detection for group chats
 * - Routing messages to the correct agent based on bindings
 * - Debounce integration via MessageQueue
 */
export class MessageRouter {
  private readonly bindings: BindingConfig[];
  private readonly botName: string;
  private readonly sessionManager: SessionManager;
  private readonly queue: MessageQueue;

  /** message_id -> timestamp for dedup. */
  private readonly seen: Map<string, number> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private routeHandler: RouteHandler | null = null;

  constructor(config: AppConfig, sessionManager: SessionManager, queue: MessageQueue) {
    this.bindings = config.bindings;
    this.botName = config.feishu.botName;
    this.sessionManager = sessionManager;
    this.queue = queue;

    // Wire up the queue's process handler
    this.queue.onProcess(this.handleQueueBatch.bind(this));

    // Start periodic dedup cleanup
    this.cleanupTimer = setInterval(() => this.cleanupDedup(), DEDUP_CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer && typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
      (this.cleanupTimer as NodeJS.Timeout).unref();
    }
  }

  /**
   * Register the handler that will be called with routed messages.
   */
  onRoute(handler: RouteHandler): void {
    this.routeHandler = handler;
  }

  /**
   * Accept an inbound message from a channel.
   * Performs dedup, mention check, routing, and enqueues for processing.
   */
  async handleInbound(message: InboundMessage): Promise<void> {
    // 1. Dedup by message_id
    if (this.isDuplicate(message.id)) {
      logger.debug(`Duplicate message ignored: ${message.id}`);
      return;
    }
    this.markSeen(message.id);

    // 2. Mention check for group chats
    if (message.peerKind === 'group') {
      if (!this.isMentioned(message)) {
        logger.debug(`Group message without mention, ignoring: ${message.id}`);
        return;
      }
    }

    // 3. Find matching binding (route)
    const route = this.resolveRoute(message);
    if (!route) {
      logger.warn(`No matching binding for message: ${message.id} (channel=${message.channelName}, peerKind=${message.peerKind}, chatId=${message.chatId})`);
      return;
    }

    logger.info(`Routing message ${message.id} to agent "${route.agentId}" (session=${route.sessionKey})`);

    // 4. Enqueue for debounced processing
    await this.queue.enqueue(route.sessionKey, message);
  }

  /**
   * Dispose timers and the queue.
   */
  dispose(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.queue.dispose();
  }

  // ---- Private helpers ----

  /**
   * Check if a message_id has been seen within the TTL window.
   */
  private isDuplicate(messageId: string): boolean {
    const ts = this.seen.get(messageId);
    if (ts === undefined) return false;
    return Date.now() - ts < DEDUP_TTL_MS;
  }

  private markSeen(messageId: string): void {
    this.seen.set(messageId, Date.now());
  }

  private cleanupDedup(): void {
    const now = Date.now();
    let removed = 0;
    for (const [id, ts] of this.seen) {
      if (now - ts >= DEDUP_TTL_MS) {
        this.seen.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      logger.debug(`Cleaned up ${removed} expired dedup entries`);
    }
  }

  /**
   * Check if the bot is mentioned in a group message.
   * Checks both the mentions array and text content for @botName.
   */
  private isMentioned(message: InboundMessage): boolean {
    // Check mentions array for bot user ID (would need bot userId injected;
    // for now also check by name in text)
    if (message.mentions && message.mentions.length > 0) {
      // If there are any mentions, assume the bot is being addressed
      // (the channel layer should filter to only include relevant mentions)
      return true;
    }

    // Fallback: check if @botName appears in text
    if (message.text && this.botName) {
      const mentionPattern = new RegExp(`@${escapeRegex(this.botName)}`, 'i');
      return mentionPattern.test(message.text);
    }

    return false;
  }

  /**
   * Find the first matching binding for the given message.
   */
  private resolveRoute(message: InboundMessage): RouteResult | null {
    const chatType = message.peerKind;

    for (const binding of this.bindings) {
      // Match channel
      if (binding.match.channel !== message.channelName) {
        continue;
      }

      // Match peer kind
      if (binding.match.peer) {
        const peerKind = binding.match.peer.kind;
        if (peerKind === 'direct' && chatType !== 'direct') continue;
        if (peerKind === 'group' && chatType !== 'group') continue;

        // Match specific peer ID if provided
        if (binding.match.peer.id) {
          const targetId = chatType === 'direct' ? message.userId : message.chatId;
          if (binding.match.peer.id !== targetId) continue;
        }
      }

      // Build session key
      const sessionKey = SessionManager.buildKey(
        message.channelName,
        chatType,
        chatType === 'direct' ? message.userId : message.chatId,
      );

      return {
        agentId: binding.agentId,
        sessionKey,
        binding,
      };
    }

    return null;
  }

  /**
   * Called by the MessageQueue when a batch of debounced messages is ready.
   */
  private async handleQueueBatch(messages: InboundMessage[], signal: AbortSignal): Promise<void> {
    if (!this.routeHandler) {
      logger.warn('No route handler registered, dropping messages');
      return;
    }

    // All messages in a batch share the same session key, so route from the last one
    const representative = messages[messages.length - 1]!;
    const route = this.resolveRoute(representative);
    if (!route) {
      logger.warn(`Could not resolve route for batched messages`);
      return;
    }

    await this.routeHandler(route, messages, signal);
  }
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
