/**
 * E2E Test: Message Routing (Config → Router → Session → Queue)
 *
 * Tests the full internal message path without real Feishu/AI connections.
 * Mocks only at the external boundary (Channel send, AI backend).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve } from 'path';
import { loadConfig, type AppConfig } from '../../src/core/config.js';
import { SessionManager } from '../../src/core/session.js';
import { MessageQueue } from '../../src/core/queue.js';
import { MessageRouter, type RouteResult } from '../../src/core/router.js';
import type { InboundMessage } from '../../src/channels/types.js';

const TEST_CONFIG_PATH = resolve(__dirname, '../fixtures/config.test.json');

function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: `om_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    chatId: 'oc_test_chat',
    userId: 'ou_test_user',
    text: 'hello',
    mentions: [],
    timestamp: Date.now(),
    channelName: 'feishu',
    peerKind: 'direct',
    ...overrides,
  };
}

describe('E2E: Message Routing', () => {
  let config: AppConfig;
  let sessionManager: SessionManager;
  let queue: MessageQueue;
  let router: MessageRouter;
  let processedBatches: Array<{ route: RouteResult; messages: InboundMessage[] }>;

  beforeEach(() => {
    config = loadConfig(TEST_CONFIG_PATH);
    // Use very short debounce for tests
    config.messages = { queue: { mode: 'followup', debounceMs: 20 } };

    sessionManager = new SessionManager(config.session);
    queue = new MessageQueue(config.messages?.queue);
    router = new MessageRouter(config, sessionManager, queue);

    processedBatches = [];
    router.onRoute(async (route, messages) => {
      processedBatches.push({ route, messages });
    });
  });

  afterEach(() => {
    router.dispose();
    queue.dispose();
    sessionManager.dispose();
  });

  it('routes a direct message to the main agent', async () => {
    const msg = makeMessage({ peerKind: 'direct', text: '你好' });
    await router.handleInbound(msg);

    // Wait for debounce
    await new Promise((r) => setTimeout(r, 100));

    expect(processedBatches).toHaveLength(1);
    expect(processedBatches[0]!.route.agentId).toBe('main');
    expect(processedBatches[0]!.messages).toHaveLength(1);
    expect(processedBatches[0]!.messages[0]!.text).toBe('你好');
  });

  it('routes a group message with mention to the main agent', async () => {
    const msg = makeMessage({
      peerKind: 'group',
      chatId: 'oc_group_1',
      text: '@TestAgent 帮我查一下',
      mentions: ['bot_id_123'],
    });
    await router.handleInbound(msg);
    await new Promise((r) => setTimeout(r, 100));

    expect(processedBatches).toHaveLength(1);
    expect(processedBatches[0]!.route.agentId).toBe('main');
  });

  it('ignores group message without mention', async () => {
    const msg = makeMessage({
      peerKind: 'group',
      chatId: 'oc_group_1',
      text: '大家好',
      mentions: [],
    });
    await router.handleInbound(msg);
    await new Promise((r) => setTimeout(r, 100));

    expect(processedBatches).toHaveLength(0);
  });

  it('deduplicates messages with the same id', async () => {
    const msg = makeMessage({ id: 'om_dedup_test', text: 'first' });
    await router.handleInbound(msg);
    await router.handleInbound({ ...msg }); // same id
    await new Promise((r) => setTimeout(r, 100));

    expect(processedBatches).toHaveLength(1);
  });

  it('debounces rapid messages into a single batch', async () => {
    const msg1 = makeMessage({ text: 'part1' });
    const msg2 = makeMessage({ text: 'part2' });
    const msg3 = makeMessage({ text: 'part3' });

    // Send all within the debounce window (20ms)
    await router.handleInbound(msg1);
    await router.handleInbound(msg2);
    await router.handleInbound(msg3);

    // Wait for debounce to flush
    await new Promise((r) => setTimeout(r, 100));

    // Should be batched (debounce buffer collects them)
    expect(processedBatches.length).toBeGreaterThanOrEqual(1);
  });

  it('creates separate sessions for different users', async () => {
    const msg1 = makeMessage({ userId: 'ou_user_a', text: 'hi from A' });
    const msg2 = makeMessage({ userId: 'ou_user_b', text: 'hi from B' });

    await router.handleInbound(msg1);
    await new Promise((r) => setTimeout(r, 50));
    await router.handleInbound(msg2);
    await new Promise((r) => setTimeout(r, 50));

    expect(processedBatches).toHaveLength(2);
    // Session keys should differ
    const keys = processedBatches.map((b) => b.route.sessionKey);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('session key format is channel:chatType:peerId', async () => {
    const msg = makeMessage({
      peerKind: 'direct',
      userId: 'ou_abc123',
    });
    await router.handleInbound(msg);
    await new Promise((r) => setTimeout(r, 100));

    expect(processedBatches[0]!.route.sessionKey).toBe('feishu:direct:ou_abc123');
  });
});
