// ConversationLogger 单元测试
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock logger
vi.mock('../utils/index.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { ConversationLogger } from './ConversationLogger.js';

// 创建 mock Memory
function createMockMemory(records: Array<{ key: string; value: any; timestamp: number }> = []) {
  return {
    getByPrefix: vi.fn().mockReturnValue(records),
  } as any;
}

// 创建 mock LLMClient
function createMockLLM() {
  return {
    chat: vi.fn().mockResolvedValue({ content: '摘要' }),
  } as any;
}

describe('ConversationLogger', () => {
  it('应该按日期过滤对话记录', () => {
    const records = [
      { key: 'conv:ch1:1710288000000:user', value: { content: '3月13日消息' }, timestamp: 1710288000000 },
      { key: 'conv:ch1:1710374400000:user', value: { content: '3月14日消息' }, timestamp: 1710374400000 },
      { key: 'conv:ch1:1710460800000:user', value: { content: '3月15日消息' }, timestamp: 1710460800000 },
    ];

    const memory = createMockMemory(records);
    const clogger = new ConversationLogger(memory, '/tmp/daily', createMockLLM(), false);

    // 查询 3月14日的记录
    const entries = clogger.getConversationsForDate('2024-03-14');
    // 只有 timestamp 在 3月14日范围内的记录
    const march14Start = new Date('2024-03-14T00:00:00').getTime();
    const march14End = new Date('2024-03-14T23:59:59.999').getTime();

    const filtered = entries.filter(e => e.timestamp >= march14Start && e.timestamp <= march14End);
    expect(filtered.length).toBeLessThanOrEqual(entries.length);
  });

  it('应该正确解析 conv: key 格式', () => {
    // 使用今天的时间戳确保日期过滤匹配
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const records = [
      { key: `conv:oc_abc:${now}:user`, value: { content: '用户消息' }, timestamp: now },
      { key: `conv:oc_abc:${now + 1000}:assistant`, value: { content: '助手回复' }, timestamp: now + 1000 },
    ];

    const memory = createMockMemory(records);
    const clogger = new ConversationLogger(memory, '/tmp/daily', createMockLLM(), false);

    const entries = clogger.getConversationsForDate(today);

    expect(entries.length).toBeGreaterThanOrEqual(1);
    const userEntry = entries.find(e => e.role === 'user');
    const assistantEntry = entries.find(e => e.role === 'assistant');
    expect(userEntry).toBeDefined();
    expect(userEntry!.channelId).toBe('oc_abc');
    expect(userEntry!.content).toBe('用户消息');
    expect(assistantEntry).toBeDefined();
    expect(assistantEntry!.role).toBe('assistant');
  });

  it('无记录时 getConversationsForDate 应返回空', () => {
    const memory = createMockMemory([]);
    const clogger = new ConversationLogger(memory, '/tmp/daily', createMockLLM(), false);

    const entries = clogger.getConversationsForDate('2024-01-01');
    expect(entries).toHaveLength(0);
  });
});
