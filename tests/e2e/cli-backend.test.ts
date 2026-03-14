/**
 * E2E Test: Claude Code CLI Backend
 *
 * Tests the actual Claude CLI integration:
 * - CLI process spawning
 * - Stream JSON parsing
 * - Response collection
 * - Timeout handling
 * - Abort handling
 *
 * Requires: `claude` CLI installed and authenticated.
 * Run with: npx vitest run --config vitest.e2e.config.ts tests/e2e/cli-backend.test.ts
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { loadConfig } from '../../src/core/config.js';
import { createAiBackend } from '../../src/ai/factory.js';
import type { AiBackend, ChatEvent, Message } from '../../src/ai/types.js';

const CLI_CONFIG_PATH = resolve(__dirname, '../fixtures/config.cli.json');

// Load env vars from .env.test if present
function loadEnvFile(): void {
  try {
    const envPath = resolve(__dirname, '../../.env.test');
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  } catch {
    // .env.test not found, rely on existing env vars
  }
}

/** Collect all events from an async iterable */
async function collectEvents(stream: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

/** Extract full text from events */
function extractText(events: ChatEvent[]): string {
  return events
    .filter((e) => e.type === 'text_delta' && e.text)
    .map((e) => e.text!)
    .join('');
}

describe('E2E: Claude Code CLI Backend', () => {
  let backend: AiBackend;

  beforeAll(() => {
    loadEnvFile();
    const config = loadConfig(CLI_CONFIG_PATH);
    expect(config.model.backend).toBe('cli');
    backend = createAiBackend(config.model);
    expect(backend).toBeDefined();
  });

  afterEach(() => {
    backend.abort();
  });

  it('creates CLI backend from config', () => {
    expect(typeof backend.chat).toBe('function');
    expect(typeof backend.abort).toBe('function');
  });

  it('sends a simple message and receives a response', { timeout: 60_000 }, async () => {
    const messages: Message[] = [
      { role: 'user', content: 'Reply with exactly: HELLO_TEST_OK' },
    ];

    const events = await collectEvents(backend.chat(messages));
    const text = extractText(events);

    // Should have received some text
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('HELLO_TEST_OK');

    // Should have a done event with usage
    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent).toBeDefined();
    if (doneEvent?.usage) {
      expect(doneEvent.usage.inputTokens).toBeGreaterThan(0);
      expect(doneEvent.usage.outputTokens).toBeGreaterThan(0);
    }
  });

  it('handles multi-turn conversation context', { timeout: 60_000 }, async () => {
    const messages: Message[] = [
      { role: 'user', content: 'Remember this number: 42' },
      { role: 'assistant', content: 'I will remember the number 42.' },
      { role: 'user', content: 'What number did I ask you to remember? Reply with just the number.' },
    ];

    const events = await collectEvents(backend.chat(messages));
    const text = extractText(events);

    expect(text).toContain('42');
  });

  it('streams text_delta events incrementally', { timeout: 60_000 }, async () => {
    const messages: Message[] = [
      { role: 'user', content: 'Count from 1 to 5, each number on a new line.' },
    ];

    const deltas: string[] = [];
    for await (const event of backend.chat(messages)) {
      if (event.type === 'text_delta' && event.text) {
        deltas.push(event.text);
      }
    }

    // Should have received multiple delta events (streaming)
    expect(deltas.length).toBeGreaterThan(1);

    const fullText = deltas.join('');
    expect(fullText).toContain('1');
    expect(fullText).toContain('5');
  });

  it('can abort an in-progress request', { timeout: 60_000 }, async () => {
    const messages: Message[] = [
      { role: 'user', content: 'Write a very long essay about the history of computing, at least 2000 words.' },
    ];

    const events: ChatEvent[] = [];
    const startTime = Date.now();

    for await (const event of backend.chat(messages)) {
      events.push(event);
      // Abort after receiving the first text delta
      if (event.type === 'text_delta') {
        backend.abort();
        break;
      }
    }

    const elapsed = Date.now() - startTime;
    // Should complete quickly after abort (not wait for full response)
    expect(elapsed).toBeLessThan(30_000);
  });

  it('handles CLI not found gracefully', { timeout: 10_000 }, async () => {
    // Create a backend with an invalid CLI path
    const { ClaudeCliBackend } = await import('../../src/ai/cli-backend.js');
    const badBackend = new ClaudeCliBackend({ path: '/nonexistent/claude-cli' });

    const messages: Message[] = [{ role: 'user', content: 'test' }];
    const events = await collectEvents(badBackend.chat(messages));

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.error).toContain('not found');
  });
});
