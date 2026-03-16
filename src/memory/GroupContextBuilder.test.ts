// GroupContextBuilder 单元测试
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

import { GroupContextBuilder, GroupContextConfig } from './GroupContextBuilder.js';

// 创建 mock Memory
function createMockMemory(records: Array<{ key: string; value: any; timestamp: number }> = []) {
  return {
    getByPrefix: vi.fn().mockReturnValue(records),
    retrieveLongTerm: vi.fn().mockResolvedValue(null),
    storeLongTerm: vi.fn().mockResolvedValue(undefined),
  } as any;
}

// 创建 mock LLMClient
function createMockLLM() {
  return {
    chat: vi.fn().mockResolvedValue({ content: '压缩摘要' }),
  } as any;
}

// 创建 mock QMDStore
function createMockQMD(results: any[] = []) {
  return {
    search: vi.fn().mockResolvedValue(results),
  } as any;
}

const defaultConfig: GroupContextConfig = {
  enabled: true,
  recentWindowMinutes: 30,
  recentMaxMessages: 20,
  searchOlderMessages: true,
  searchTopK: 5,
  compressOlderMessages: false,
  compressThresholdMessages: 50,
};

describe('GroupContextBuilder', () => {
  describe('buildContext', () => {
    it('应该为群聊构建上下文', async () => {
      const now = Date.now();
      const records = [
        { key: 'conv:ch1:1:user', value: { content: '你好' }, timestamp: now - 5 * 60 * 1000 },
        { key: 'conv:ch1:2:assistant', value: { content: '你好！有什么可以帮你的？' }, timestamp: now - 4 * 60 * 1000 },
      ];

      const memory = createMockMemory(records);
      const builder = new GroupContextBuilder(memory, createMockLLM(), defaultConfig);

      const ctx = await builder.buildContext('ch1', '新消息');
      expect(ctx).toContain('历史消息上下文');
      expect(ctx).toContain('你好');
      expect(ctx).toContain('你好！有什么可以帮你的？');
    });

    it('应该为私聊构建上下文（不再限制 chatType）', async () => {
      const now = Date.now();
      const records = [
        { key: 'conv:private1:1:user', value: { content: '私聊消息' }, timestamp: now - 5 * 60 * 1000 },
      ];

      const memory = createMockMemory(records);
      const builder = new GroupContextBuilder(memory, createMockLLM(), defaultConfig);

      const ctx = await builder.buildContext('private1', '新消息');
      expect(ctx).toContain('私聊消息');
    });

    it('无历史消息时应返回空字符串', async () => {
      const memory = createMockMemory([]);
      const builder = new GroupContextBuilder(memory, createMockLLM(), defaultConfig);

      const ctx = await builder.buildContext('ch1', '新消息');
      expect(ctx).toBe('');
    });
  });

  describe('近期消息', () => {
    it('应该包含 recentWindowMinutes 内的消息', async () => {
      const now = Date.now();
      const records = [
        { key: 'conv:ch1:1:user', value: { content: '近期消息' }, timestamp: now - 10 * 60 * 1000 },
        { key: 'conv:ch1:2:user', value: { content: '远期消息' }, timestamp: now - 60 * 60 * 1000 },
      ];

      const memory = createMockMemory(records);
      const builder = new GroupContextBuilder(memory, createMockLLM(), defaultConfig);

      const ctx = await builder.buildContext('ch1', '新消息');
      expect(ctx).toContain('近期消息');
    });

    it('应该限制最多 recentMaxMessages 条', async () => {
      const now = Date.now();
      const records = Array.from({ length: 30 }, (_, i) => ({
        key: `conv:ch1:${i}:user`,
        value: { content: `消息${i}` },
        timestamp: now - (29 - i) * 60 * 1000, // 全在30分钟内
      }));

      const config = { ...defaultConfig, recentMaxMessages: 5 };
      const memory = createMockMemory(records);
      const builder = new GroupContextBuilder(memory, createMockLLM(), config);

      const ctx = await builder.buildContext('ch1', '新消息');
      // 应该只有最近 5 条（消息25~消息29）
      expect(ctx).toContain('消息29');
      expect(ctx).toContain('消息25');
      expect(ctx).not.toContain('消息20');
    });
  });

  describe('远期消息检索', () => {
    it('有 QMDStore 时应使用语义检索', async () => {
      const now = Date.now();
      const records = [
        { key: 'conv:ch1:1:user', value: { content: '近期' }, timestamp: now - 5 * 60 * 1000 },
      ];

      const qmdResults = [
        { content: 'QMD语义结果', channelId: 'ch1', role: 'user', timestamp: now - 2 * 60 * 60 * 1000, score: 0.9 },
      ];

      const memory = createMockMemory(records);
      const qmd = createMockQMD(qmdResults);
      const builder = new GroupContextBuilder(memory, createMockLLM(), defaultConfig, qmd);

      const ctx = await builder.buildContext('ch1', '搜索相关话题');
      expect(qmd.search).toHaveBeenCalledWith('搜索相关话题', expect.objectContaining({
        channelId: 'ch1',
      }));
      expect(ctx).toContain('QMD语义结果');
    });

    it('无 QMDStore 时应回退关键词匹配', async () => {
      const now = Date.now();
      const records = [
        { key: 'conv:ch1:1:user', value: { content: '关键词匹配测试' }, timestamp: now - 60 * 60 * 1000 },
        { key: 'conv:ch1:2:user', value: { content: '无关内容' }, timestamp: now - 59 * 60 * 1000 },
        { key: 'conv:ch1:3:user', value: { content: '近期消息' }, timestamp: now - 5 * 60 * 1000 },
      ];

      const memory = createMockMemory(records);
      const builder = new GroupContextBuilder(memory, createMockLLM(), defaultConfig);

      const ctx = await builder.buildContext('ch1', '关键词匹配');
      expect(ctx).toContain('关键词匹配测试');
    });
  });
});
