// Memory 单元测试
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Memory } from './Memory.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('Memory', () => {
  let memory: Memory;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `memory-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    memory = new Memory(tempDir, 10, 1000);
    await memory.init();
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (e) {
      // ignore
    }
  });

  describe('短期记忆存取', () => {
    it('应该添加短期记忆', () => {
      memory.storeShortTerm('test-key', 'test value');
      const result = memory.retrieveShortTerm('test-key');
      expect(result).toBe('test value');
    });

    it('应该删除短期记忆', () => {
      memory.storeShortTerm('test-key', 'test value');
      memory.deleteShortTerm('test-key');
      const result = memory.retrieveShortTerm('test-key');
      expect(result).toBeUndefined();
    });

    it('应该限制短期记忆数量', () => {
      for (let i = 0; i < 15; i++) {
        memory.storeShortTerm(`key-${i}`, `value-${i}`);
      }
      const recent = memory.getRecentShortTerm(20);
      expect(recent.length).toBeLessThanOrEqual(10);
    });
  });

  describe('长期记忆存取', () => {
    it('应该添加长期记忆', async () => {
      await memory.storeLongTerm('long-term-key', 'long term value');
      const result = await memory.retrieveLongTerm('long-term-key');
      expect(result).toBe('long term value');
    });

    it('应该搜索长期记忆', async () => {
      await memory.storeLongTerm('key1', { content: 'hello world' });
      await memory.storeLongTerm('key2', { content: 'foo bar' });
      const results = await memory.searchLongTerm('hello');
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('getByPrefix', () => {
    it('应该按前缀查询长期记忆', async () => {
      await memory.storeLongTerm('conv:ch1:1000:user', { content: '消息1' });
      await memory.storeLongTerm('conv:ch1:2000:assistant', { content: '回复1' });
      await memory.storeLongTerm('conv:ch2:3000:user', { content: '消息2' });

      const results = memory.getByPrefix('conv:ch1:');
      expect(results).toHaveLength(2);
      expect(results[0].key).toBe('conv:ch1:1000:user');
      expect(results[1].key).toBe('conv:ch1:2000:assistant');
    });

    it('结果应按 timestamp 排序', async () => {
      await memory.storeLongTerm('conv:ch1:3000:user', { content: '后来的' });
      // 手动设置更早的 timestamp
      await memory.storeLongTerm('conv:ch1:1000:user', { content: '早期的' });

      const results = memory.getByPrefix('conv:ch1:');
      expect(results.length).toBeGreaterThanOrEqual(2);
      // 应该按时间升序
      for (let i = 1; i < results.length; i++) {
        expect(results[i].timestamp).toBeGreaterThanOrEqual(results[i - 1].timestamp);
      }
    });

    it('前缀不匹配时应返回空', async () => {
      await memory.storeLongTerm('conv:ch1:1000:user', { content: '消息' });
      const results = memory.getByPrefix('conv:ch999:');
      expect(results).toHaveLength(0);
    });
  });

  describe('getLongTermCount', () => {
    it('应该返回正确的长期记忆数量', async () => {
      expect(memory.getLongTermCount()).toBe(0);
      await memory.storeLongTerm('key1', 'val1');
      await memory.storeLongTerm('key2', 'val2');
      expect(memory.getLongTermCount()).toBe(2);
    });
  });

  describe('清理', () => {
    it('应该清理', async () => {
      await memory.cleanup();
      // 不报错即可
      expect(true).toBe(true);
    });
  });
});
