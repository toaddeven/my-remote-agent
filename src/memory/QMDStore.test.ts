// QMDStore 单元测试
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Mock fns must be declared via vi.hoisted so they're available in factory
const { mockAdd, mockSearch, mockClose } = vi.hoisted(() => ({
  mockAdd: vi.fn(),
  mockSearch: vi.fn(),
  mockClose: vi.fn(),
}));

// Mock QMD SDK
vi.mock('@tobilu/qmd', () => ({
  createStore: vi.fn().mockResolvedValue({
    add: mockAdd,
    search: mockSearch,
    close: mockClose,
  }),
}));

// Mock logger
vi.mock('../utils/index.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { QMDStore } from './QMDStore.js';

describe('QMDStore', () => {
  let store: QMDStore;
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = path.join(os.tmpdir(), `qmd-test-${Date.now()}`);
    store = new QMDStore({
      enabled: true,
      dbPath: tempDir,
      collectionName: 'test-conv',
      minScore: 0.25,
    });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe('init / close', () => {
    it('init 应该创建数据目录', async () => {
      const stat = await fs.stat(tempDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('close 后不应 crash', async () => {
      await store.close();
      // 再次 close 也不应报错
      await store.close();
    });
  });

  describe('indexMessage', () => {
    it('应该调用 store.add 写入消息', async () => {
      await store.indexMessage({
        channelId: 'oc_123',
        content: '你好世界',
        role: 'user',
        timestamp: 1710000000000,
      });

      expect(mockAdd).toHaveBeenCalledOnce();
      const call = mockAdd.mock.calls[0][0];
      expect(call.id).toBe('oc_123-1710000000000-user');
      expect(call.content).toContain('你好世界');
      expect(call.content).toContain('channelId: oc_123');
      expect(call.content).toContain('role: user');
      expect(call.metadata).toEqual({
        channelId: 'oc_123',
        role: 'user',
        timestamp: 1710000000000,
      });
    });

    it('文件内容应包含 frontmatter 元数据', async () => {
      await store.indexMessage({
        channelId: 'oc_456',
        content: '测试消息',
        role: 'assistant',
        timestamp: 1710000001000,
      });

      const content = mockAdd.mock.calls[0][0].content;
      expect(content).toContain('---');
      expect(content).toContain('channelId: oc_456');
      expect(content).toContain('role: assistant');
      expect(content).toContain('timestamp: 1710000001000');
      expect(content).toContain('测试消息');
    });

    it('应该处理空内容', async () => {
      await store.indexMessage({
        channelId: 'oc_789',
        content: '',
        role: 'user',
        timestamp: 1710000002000,
      });

      expect(mockAdd).toHaveBeenCalledOnce();
    });
  });

  describe('search', () => {
    it('应该返回相关结果', async () => {
      mockSearch.mockResolvedValueOnce([
        {
          content: '---\nchannelId: oc_1\nrole: user\ntimestamp: 1710000000000\n---\n你好',
          metadata: { channelId: 'oc_1', role: 'user', timestamp: 1710000000000 },
          score: 0.8,
        },
      ]);

      const results = await store.search('你好');
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('你好');
      expect(results[0].channelId).toBe('oc_1');
      expect(results[0].role).toBe('user');
      expect(results[0].score).toBe(0.8);
    });

    it('无结果时应返回空数组', async () => {
      mockSearch.mockResolvedValueOnce([]);
      const results = await store.search('不存在的内容');
      expect(results).toHaveLength(0);
    });

    it('应该按 channelId 过滤', async () => {
      mockSearch.mockResolvedValueOnce([]);
      await store.search('测试', { channelId: 'oc_specific' });

      expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({
        filter: { channelId: 'oc_specific' },
      }));
    });

    it('应该尊重 minScore 阈值', async () => {
      mockSearch.mockResolvedValueOnce([
        { content: '高分结果', metadata: { channelId: 'oc_1', role: 'user', timestamp: 1 }, score: 0.8 },
        { content: '低分结果', metadata: { channelId: 'oc_1', role: 'user', timestamp: 2 }, score: 0.1 },
      ]);

      const results = await store.search('测试');
      // 低分结果（0.1）应被 minScore（0.25）过滤掉
      expect(results).toHaveLength(1);
      expect(results[0].score).toBe(0.8);
    });
  });
});
