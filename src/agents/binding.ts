/**
 * Route Binding
 *
 * Maps chat/peer patterns to agents using the config.bindings schema.
 * Supports wildcard matching: when peer.id is omitted, all peers of
 * that kind are matched.
 */

import type { BindingConfig } from '../core/config.js';
import type { InboundMessage } from '../channels/types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('binding');

/** Result of a successful binding match. */
export interface BindingMatch {
  readonly agentId: string;
  readonly binding: BindingConfig;
}

export class BindingRouter {
  private readonly bindings: BindingConfig[];

  constructor(bindings: BindingConfig[]) {
    this.bindings = bindings;
    logger.info(`BindingRouter initialized with ${bindings.length} binding(s)`);
  }

  /**
   * Find the first binding that matches the given inbound message.
   *
   * Matching rules (evaluated in order):
   * 1. binding.match.channel must equal message.channelName
   * 2. If binding.match.peer is defined:
   *    a. peer.kind must match message.peerKind
   *    b. If peer.id is specified, it must match the message's peerId
   *       (userId for direct, chatId for group)
   *    c. If peer.id is omitted, all peers of that kind match (wildcard)
   * 3. If binding.match.peer is undefined, all peers on that channel match
   *
   * @returns The first matching binding, or undefined if none match.
   */
  resolve(message: InboundMessage): BindingMatch | undefined {
    for (const binding of this.bindings) {
      if (this.matches(binding, message)) {
        logger.debug(`Binding matched`, {
          agentId: binding.agentId,
          channel: binding.match.channel,
          peerId: this.getPeerId(message),
        });
        return { agentId: binding.agentId, binding };
      }
    }

    logger.debug('No binding matched', {
      channel: message.channelName,
      peerKind: message.peerKind,
      peerId: this.getPeerId(message),
    });
    return undefined;
  }

  /**
   * Find all bindings that match the given message.
   * Useful for debugging or multi-agent scenarios.
   */
  resolveAll(message: InboundMessage): BindingMatch[] {
    const results: BindingMatch[] = [];
    for (const binding of this.bindings) {
      if (this.matches(binding, message)) {
        results.push({ agentId: binding.agentId, binding });
      }
    }
    return results;
  }

  /** Return the current binding list (readonly). */
  getBindings(): readonly BindingConfig[] {
    return this.bindings;
  }

  private matches(binding: BindingConfig, message: InboundMessage): boolean {
    // Channel must match
    if (binding.match.channel !== message.channelName) {
      return false;
    }

    // If no peer constraint, match all peers on this channel
    if (!binding.match.peer) {
      return true;
    }

    // Peer kind must match
    const expectedKind = binding.match.peer.kind;
    if (expectedKind !== message.peerKind) {
      return false;
    }

    // If peer.id is specified, it must match the concrete peer ID
    if (binding.match.peer.id) {
      const actualId = this.getPeerId(message);
      return binding.match.peer.id === actualId;
    }

    // No peer.id means wildcard — match all peers of this kind
    return true;
  }

  /**
   * Extract the peer ID from a message.
   * For direct messages: userId; for group messages: chatId.
   */
  private getPeerId(message: InboundMessage): string {
    return message.peerKind === 'direct' ? message.userId : message.chatId;
  }
}
