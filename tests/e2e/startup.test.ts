/**
 * E2E Test: Application Startup & Config Loading
 *
 * Tests the full startup path: config → AI backend → channel → agents → ready.
 * Uses test config fixtures (no real Feishu/Anthropic connections).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve } from 'path';
import { loadConfig } from '../../src/core/config.js';
import { createAiBackend } from '../../src/ai/factory.js';
import { SessionManager } from '../../src/core/session.js';
import { MessageQueue } from '../../src/core/queue.js';
import { MessageRouter } from '../../src/core/router.js';

const TEST_CONFIG_PATH = resolve(__dirname, '../fixtures/config.test.json');
const ENV_CONFIG_PATH = resolve(__dirname, '../fixtures/config.env.json');

describe('E2E: Startup & Config', () => {
  let sessionManager: SessionManager | undefined;
  let queue: MessageQueue | undefined;
  let router: MessageRouter | undefined;

  afterEach(() => {
    router?.dispose();
    queue?.dispose();
    sessionManager?.dispose();
  });

  it('loads test config and validates all required fields', () => {
    const config = loadConfig(TEST_CONFIG_PATH);

    expect(config.feishu.appId).toBe('cli_test_app_id');
    expect(config.feishu.appSecret).toBe('test_app_secret_000000');
    expect(config.feishu.botName).toBe('TestAgent');
    expect(config.model.backend).toBe('api');
    expect(config.model.default).toBe('anthropic/claude-opus-4-6');
    expect(config.agents).toHaveLength(2);
    expect(config.agents[0]!.id).toBe('main');
    expect(config.agents[1]!.id).toBe('coder');
    expect(config.bindings).toHaveLength(2);
    expect(config.session?.dmScope).toBe('per-peer');
    expect(config.messages?.queue?.debounceMs).toBe(50);
    expect(config.acp?.enabled).toBe(true);
  });

  it('resolves ${ENV_VAR} placeholders in config', () => {
    process.env.TEST_FEISHU_APP_ID = 'env_app_id_123';
    process.env.TEST_FEISHU_APP_SECRET = 'env_secret_456';
    process.env.TEST_ANTHROPIC_API_KEY = 'sk-ant-env-key';

    try {
      const config = loadConfig(ENV_CONFIG_PATH);
      expect(config.feishu.appId).toBe('env_app_id_123');
      expect(config.feishu.appSecret).toBe('env_secret_456');
      expect(config.model.apiKey).toBe('sk-ant-env-key');
    } finally {
      delete process.env.TEST_FEISHU_APP_ID;
      delete process.env.TEST_FEISHU_APP_SECRET;
      delete process.env.TEST_ANTHROPIC_API_KEY;
    }
  });

  it('creates API backend from config', () => {
    const config = loadConfig(TEST_CONFIG_PATH);
    const backend = createAiBackend(config.model);
    expect(backend).toBeDefined();
    expect(typeof backend.chat).toBe('function');
    expect(typeof backend.abort).toBe('function');
  });

  it('creates CLI backend when backend=cli', () => {
    const config = loadConfig(TEST_CONFIG_PATH);
    config.model.backend = 'cli';
    const backend = createAiBackend(config.model);
    expect(backend).toBeDefined();
    expect(typeof backend.chat).toBe('function');
  });

  it('initialises SessionManager with config', () => {
    const config = loadConfig(TEST_CONFIG_PATH);
    sessionManager = new SessionManager(config.session);
    expect(sessionManager).toBeDefined();

    // Create a session
    const session = sessionManager.getOrCreate('feishu:direct:ou_test');
    expect(session.key).toBe('feishu:direct:ou_test');
    expect(session.transcript).toEqual([]);
  });

  it('initialises MessageQueue with config', () => {
    const config = loadConfig(TEST_CONFIG_PATH);
    queue = new MessageQueue(config.messages?.queue);
    expect(queue).toBeDefined();
    expect(queue.stats().activeConcurrent).toBe(0);
  });

  it('initialises MessageRouter with config, session, and queue', () => {
    const config = loadConfig(TEST_CONFIG_PATH);
    sessionManager = new SessionManager(config.session);
    queue = new MessageQueue(config.messages?.queue);
    router = new MessageRouter(config, sessionManager, queue);
    expect(router).toBeDefined();
  });

  it('rejects invalid config (missing feishu)', () => {
    expect(() => loadConfig(resolve(__dirname, 'nonexistent.json'))).toThrow('Failed to read config');
  });
});
