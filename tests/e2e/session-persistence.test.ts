/**
 * E2E Test: Session Persistence (JSONL read/write/archive)
 *
 * Tests real file I/O against a temp directory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { SessionManager } from '../../src/core/session.js';

describe('E2E: Session Persistence', () => {
  let sessionManager: SessionManager;
  let sessionsDir: string;

  beforeEach(() => {
    // SessionManager uses ~/.my-agent/sessions/ — we use manual reset to avoid daily timer
    sessionManager = new SessionManager({
      dmScope: 'per-peer',
      reset: { kind: 'manual' },
      maxContextMessages: 50,
    });
    sessionsDir = join(homedir(), '.my-agent', 'sessions');
  });

  afterEach(() => {
    sessionManager.dispose();
    // Clean up test session files
    const testFiles = ['feishu_direct_ou_persist_test.jsonl'];
    for (const f of testFiles) {
      const p = join(sessionsDir, f);
      if (existsSync(p)) {
        rmSync(p);
      }
    }
  });

  it('creates a new session and persists messages to JSONL', async () => {
    const key = 'feishu:direct:ou_persist_test';

    // Add messages
    await sessionManager.addMessage(key, 'user', '你好');
    await sessionManager.addMessage(key, 'assistant', '你好！有什么可以帮你的？');
    await sessionManager.addMessage(key, 'user', '今天天气怎么样？');

    // Verify in-memory
    const session = sessionManager.getOrCreate(key);
    expect(session.transcript).toHaveLength(3);

    // Verify file on disk
    const filePath = join(sessionsDir, 'feishu_direct_ou_persist_test.jsonl');
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(3);

    const entry0 = JSON.parse(lines[0]!);
    expect(entry0.role).toBe('user');
    expect(entry0.content).toBe('你好');

    const entry1 = JSON.parse(lines[1]!);
    expect(entry1.role).toBe('assistant');
    expect(entry1.content).toBe('你好！有什么可以帮你的？');
  });

  it('reloads session from JSONL after eviction', async () => {
    const key = 'feishu:direct:ou_persist_test';

    await sessionManager.addMessage(key, 'user', 'message one');
    await sessionManager.addMessage(key, 'assistant', 'reply one');

    // Evict from memory
    sessionManager.evict(key);

    // Reload — should read from disk
    const session = sessionManager.getOrCreate(key);
    expect(session.transcript).toHaveLength(2);
    expect(session.transcript[0]!.content).toBe('message one');
    expect(session.transcript[1]!.content).toBe('reply one');
  });

  it('getContext returns at most maxContextMessages', async () => {
    const key = 'feishu:direct:ou_persist_test';

    // Add 60 messages (exceeds maxContextMessages=50)
    for (let i = 0; i < 60; i++) {
      await sessionManager.addMessage(key, i % 2 === 0 ? 'user' : 'assistant', `msg ${i}`);
    }

    const context = sessionManager.getContext(key);
    expect(context).toHaveLength(50);
    // Should be the most recent 50
    expect(context[0]!.content).toBe('msg 10');
    expect(context[49]!.content).toBe('msg 59');
  });

  it('handles malformed JSONL lines gracefully', async () => {
    const key = 'feishu:direct:ou_persist_test';
    const filePath = join(sessionsDir, 'feishu_direct_ou_persist_test.jsonl');

    // Write a file with corrupt lines
    mkdirSync(sessionsDir, { recursive: true });
    const content = [
      JSON.stringify({ role: 'user', content: 'good line 1', timestamp: Date.now() }),
      '{corrupt json here',
      JSON.stringify({ role: 'assistant', content: 'good line 2', timestamp: Date.now() }),
      '',
      'not json at all',
      JSON.stringify({ role: 'user', content: 'good line 3', timestamp: Date.now() }),
    ].join('\n');
    writeFileSync(filePath, content);

    // Load — should skip bad lines
    const session = sessionManager.getOrCreate(key);
    expect(session.transcript).toHaveLength(3);
    expect(session.transcript[0]!.content).toBe('good line 1');
    expect(session.transcript[1]!.content).toBe('good line 2');
    expect(session.transcript[2]!.content).toBe('good line 3');
  });

  it('resets a session and clears transcript', async () => {
    const key = 'feishu:direct:ou_persist_test';

    await sessionManager.addMessage(key, 'user', 'before reset');
    await sessionManager.reset(key);

    const session = sessionManager.getOrCreate(key);
    expect(session.transcript).toHaveLength(0);
  });
});
