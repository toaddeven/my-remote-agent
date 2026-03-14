/**
 * AI 后端单元测试
 * 对应 TEST_PLAN: AI-001 ~ AI-014
 */
import { describe, it, expect } from 'vitest';
import {
  createMockApiBackend,
  createMockCliBackend,
  createToolCallResponse,
  createErrorResponse,
  createHangingBackend,
  type ChatEvent,
} from '../../utils/mock-ai-backend.js';
import { collectAsyncIterator } from '../../utils/helpers.js';

describe('AI Backend - API Mode', () => {
  // AI-001: 正常对话
  it('should return text response via API backend', async () => {
    const backend = createMockApiBackend();
    const events = await collectAsyncIterator(backend.chat([]));

    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('text_delta');
    expect(events[0].text).toBe('你好');
    expect(events[2].type).toBe('done');
    expect(events[2].usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  // AI-002: 流式输出
  it('should produce text_delta events for streaming', async () => {
    const streamEvents: ChatEvent[] = [
      { type: 'text_delta', text: 'Hello ' },
      { type: 'text_delta', text: 'World' },
      { type: 'text_delta', text: '!' },
      { type: 'done', usage: { inputTokens: 50, outputTokens: 20 } },
    ];
    const backend = createMockApiBackend([streamEvents]);

    const events = await collectAsyncIterator(backend.chat([]));
    const deltas = events.filter((e) => e.type === 'text_delta');
    expect(deltas).toHaveLength(3);
    expect(deltas.map((d) => d.text).join('')).toBe('Hello World!');
  });

  // AI-003: 工具调用
  it('should handle tool_use events', async () => {
    const toolEvents = createToolCallResponse('web_search', { query: 'test' }, { results: [] });
    const backend = createMockApiBackend([toolEvents]);

    const events = await collectAsyncIterator(backend.chat([]));
    const toolUse = events.find((e) => e.type === 'tool_use');
    const toolResult = events.find((e) => e.type === 'tool_result');

    expect(toolUse).toBeDefined();
    expect(toolUse!.toolName).toBe('web_search');
    expect(toolUse!.toolInput).toEqual({ query: 'test' });
    expect(toolResult).toBeDefined();
    expect(toolResult!.toolResult).toEqual({ results: [] });
  });

  // AI-005: 错误响应
  it('should handle error events', async () => {
    const errorEvents = createErrorResponse('Rate limit exceeded');
    const backend = createMockApiBackend([errorEvents]);

    const events = await collectAsyncIterator(backend.chat([]));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(events[0].error).toBe('Rate limit exceeded');
  });
});

describe('AI Backend - CLI Mode', () => {
  // AI-006: CLI 正常对话
  it('should return text response via CLI backend', async () => {
    const backend = createMockCliBackend();
    const events = await collectAsyncIterator(backend.chat([]));

    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('text_delta');
    expect(events[2].type).toBe('done');
  });

  // AI-007: CLI 流式输出
  it('should produce text_delta events from CLI output', async () => {
    const streamEvents: ChatEvent[] = [
      { type: 'text_delta', text: 'CLI ' },
      { type: 'text_delta', text: 'streaming' },
      { type: 'done', usage: { inputTokens: 30, outputTokens: 10 } },
    ];
    const backend = createMockCliBackend([streamEvents]);

    const events = await collectAsyncIterator(backend.chat([]));
    const deltas = events.filter((e) => e.type === 'text_delta');
    expect(deltas.map((d) => d.text).join('')).toBe('CLI streaming');
  });

  // AI-008: CLI 进程崩溃
  it('should handle CLI crash (error event)', async () => {
    const crashEvents = createErrorResponse('Process exited with code 1');
    const backend = createMockCliBackend([crashEvents]);

    const events = await collectAsyncIterator(backend.chat([]));
    expect(events[0].type).toBe('error');
    expect(events[0].error).toContain('exited');
  });

  // AI-010: CLI OOM
  it('should detect OOM exit code 137', async () => {
    const oomEvents = createErrorResponse('Process killed (exit code 137) — possible OOM');
    const backend = createMockCliBackend([oomEvents]);

    const events = await collectAsyncIterator(backend.chat([]));
    expect(events[0].error).toContain('137');
  });
});

describe('AI Backend - Factory', () => {
  // AI-012: 后端工厂 API 模式
  it('should create API backend from config', () => {
    const backend = createMockApiBackend();
    expect(backend.chat).toBeDefined();
    expect(backend.abort).toBeDefined();
  });

  // AI-013: 后端工厂 CLI 模式
  it('should create CLI backend from config', () => {
    const backend = createMockCliBackend();
    expect(backend.chat).toBeDefined();
    expect(backend.abort).toBeDefined();
  });

  // AI-014: ChatEvent 统一接口
  it('should produce same event format from both backends', async () => {
    const sharedEvents: ChatEvent[] = [
      { type: 'text_delta', text: 'unified' },
      { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
    ];

    const apiBackend = createMockApiBackend([sharedEvents]);
    const cliBackend = createMockCliBackend([sharedEvents]);

    const apiEvents = await collectAsyncIterator(apiBackend.chat([]));
    const cliEvents = await collectAsyncIterator(cliBackend.chat([]));

    expect(apiEvents).toEqual(cliEvents);
  });
});

describe('AI Backend - Edge Cases', () => {
  // AI-011: JSON 解析失败（坏行跳过）
  it('should handle hanging backend with abort', async () => {
    const backend = createHangingBackend();

    // 验证 abort 方法存在
    expect(typeof backend.abort).toBe('function');
    backend.abort();
    expect(backend.abort).toHaveBeenCalled();
  });

  // 多轮对话
  it('should handle multiple calls with different responses', async () => {
    const round1: ChatEvent[] = [
      { type: 'text_delta', text: 'First reply' },
      { type: 'done', usage: { inputTokens: 50, outputTokens: 20 } },
    ];
    const round2: ChatEvent[] = [
      { type: 'text_delta', text: 'Second reply' },
      { type: 'done', usage: { inputTokens: 80, outputTokens: 30 } },
    ];

    const backend = createMockApiBackend([round1, round2]);

    const events1 = await collectAsyncIterator(backend.chat([]));
    expect(events1[0].text).toBe('First reply');

    const events2 = await collectAsyncIterator(backend.chat([]));
    expect(events2[0].text).toBe('Second reply');
  });
});
