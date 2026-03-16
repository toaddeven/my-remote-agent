// ClaudeCLIServer 单元测试
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// Mock logger
vi.mock('../utils/index.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { spawn } from 'child_process';
import { ClaudeCLIServer, ClaudeCLIError } from './ClaudeCLIServer.js';

const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>;

// 创建模拟的子进程，可配置输出
function createMockProcess(jsonResponse?: object, exitCode = 0) {
  const proc = new EventEmitter() as any;
  const stdinChunks: string[] = [];
  proc.stdin = new Writable({
    write(chunk, encoding, callback) {
      stdinChunks.push(chunk.toString());
      callback();
    },
    final(callback) {
      callback();
    },
  });
  proc.stdin._chunks = stdinChunks;
  proc.stdout = new Readable({
    read() {
      if (jsonResponse) {
        this.push(JSON.stringify(jsonResponse));
        this.push(null);
        jsonResponse = undefined; // 只推一次
      }
    },
  });
  proc.stderr = new Readable({ read() { this.push(null); } });
  proc.kill = vi.fn();
  proc.pid = Math.floor(Math.random() * 10000);

  // 模拟进程退出
  setTimeout(() => proc.emit('close', exitCode), 10);

  return proc;
}

function makeResult(content: string, sessionId: string) {
  return {
    type: 'result',
    subtype: 'success',
    result: content,
    session_id: sessionId,
    total_cost_usd: 0.01,
    duration_ms: 1000,
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

describe('ClaudeCLIServer', () => {
  let server: ClaudeCLIServer;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    server?.destroy();
  });

  describe('sendMessage', () => {
    it('应该 spawn claude --print 并返回响应', async () => {
      const resp = makeResult('你好！', 'session-abc');
      mockSpawn.mockReturnValueOnce(createMockProcess(resp));

      server = new ClaudeCLIServer({ cliPath: '/usr/bin/claude' });
      const result = await server.sendMessage('channel-1', '你好');

      expect(result.content).toBe('你好！');
      expect(result.sessionId).toBe('session-abc');
      expect(result.usage?.inputTokens).toBe(10);
      expect(result.usage?.outputTokens).toBe(20);
      expect(result.costUsd).toBe(0.01);

      // 验证 spawn 参数
      expect(mockSpawn).toHaveBeenCalledWith(
        '/usr/bin/claude',
        expect.arrayContaining(['--print', '--output-format', 'json']),
        expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
      );
      // 首次调用不应该有 --resume
      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain('--resume');
    });

    it('应该在第二次调用时使用 --resume', async () => {
      const resp1 = makeResult('回复1', 'session-123');
      const resp2 = makeResult('回复2', 'session-123');
      mockSpawn
        .mockReturnValueOnce(createMockProcess(resp1))
        .mockReturnValueOnce(createMockProcess(resp2));

      server = new ClaudeCLIServer();

      await server.sendMessage('channel-1', '消息1');
      await server.sendMessage('channel-1', '消息2');

      // 第二次调用应该包含 --resume
      const args2 = mockSpawn.mock.calls[1][1] as string[];
      expect(args2).toContain('--resume');
      expect(args2).toContain('session-123');
    });

    it('应该为不同 channel 使用不同 session', async () => {
      const resp1 = makeResult('回复1', 'session-a');
      const resp2 = makeResult('回复2', 'session-b');
      mockSpawn
        .mockReturnValueOnce(createMockProcess(resp1))
        .mockReturnValueOnce(createMockProcess(resp2));

      server = new ClaudeCLIServer();

      await server.sendMessage('channel-1', '消息1');
      await server.sendMessage('channel-2', '消息2');

      // 两次都不应该有 --resume（各自首次调用）
      const args1 = mockSpawn.mock.calls[0][1] as string[];
      const args2 = mockSpawn.mock.calls[1][1] as string[];
      expect(args1).not.toContain('--resume');
      expect(args2).not.toContain('--resume');
    });

    it('应该将消息写入 stdin', async () => {
      const resp = makeResult('OK', 'session-1');
      const proc = createMockProcess(resp);
      mockSpawn.mockReturnValueOnce(proc);

      server = new ClaudeCLIServer();
      await server.sendMessage('channel-1', '测试消息');

      expect(proc.stdin._chunks).toContain('测试消息');
    });

    it('应该传递额外的 cliFlags', async () => {
      const resp = makeResult('OK', 'session-1');
      mockSpawn.mockReturnValueOnce(createMockProcess(resp));

      server = new ClaudeCLIServer({ cliFlags: ['--permission-mode', 'bypass'] });
      await server.sendMessage('channel-1', '消息');

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).toContain('--permission-mode');
      expect(args).toContain('bypass');
    });
  });

  describe('--resume 失败重试', () => {
    it('应该在 --resume 失败时清除 session 重试', async () => {
      const resp1 = makeResult('回复1', 'session-old');
      mockSpawn.mockReturnValueOnce(createMockProcess(resp1));

      server = new ClaudeCLIServer();
      await server.sendMessage('channel-1', '消息1');

      // 第二次 --resume 失败
      const failProc = new EventEmitter() as any;
      failProc.stdin = new Writable({ write(c, e, cb) { cb(); }, final(cb) { cb(); } });
      failProc.stdout = new Readable({ read() { this.push(null); } });
      failProc.stderr = new Readable({
        read() { this.push('Error: session not found'); this.push(null); },
      });
      failProc.kill = vi.fn();
      setTimeout(() => failProc.emit('close', 1), 10);

      // 重试成功
      const resp3 = makeResult('回复重试', 'session-new');

      mockSpawn
        .mockReturnValueOnce(failProc)
        .mockReturnValueOnce(createMockProcess(resp3));

      const result = await server.sendMessage('channel-1', '消息2');
      expect(result.content).toBe('回复重试');
      expect(result.sessionId).toBe('session-new');

      // 第三次调用应该有 --resume session-new
      const args3 = mockSpawn.mock.calls[2][1] as string[];
      expect(args3).not.toContain('--resume'); // 重试时没有 --resume
    });
  });

  describe('错误处理', () => {
    it('应该处理 CLI 未找到', async () => {
      const proc = new EventEmitter() as any;
      proc.stdin = new Writable({ write(c, e, cb) { cb(); }, final(cb) { cb(); } });
      proc.stdout = new Readable({ read() { this.push(null); } });
      proc.stderr = new Readable({ read() { this.push(null); } });
      proc.kill = vi.fn();
      mockSpawn.mockReturnValueOnce(proc);

      // 模拟 ENOENT 错误
      setTimeout(() => {
        const err = new Error('spawn ENOENT') as any;
        err.code = 'ENOENT';
        proc.emit('error', err);
      }, 10);

      server = new ClaudeCLIServer({ cliPath: '/nonexistent/claude' });
      await expect(server.sendMessage('ch-1', 'hi')).rejects.toThrow('未找到');
    });

    it('应该处理非零退出码', async () => {
      const proc = new EventEmitter() as any;
      proc.stdin = new Writable({ write(c, e, cb) { cb(); }, final(cb) { cb(); } });
      proc.stdout = new Readable({ read() { this.push(null); } });
      proc.stderr = new Readable({
        read() { this.push('Some error'); this.push(null); },
      });
      proc.kill = vi.fn();
      setTimeout(() => proc.emit('close', 1), 10);
      mockSpawn.mockReturnValueOnce(proc);

      server = new ClaudeCLIServer();
      await expect(server.sendMessage('ch-1', 'hi')).rejects.toThrow('退出码 1');
    });

    it('应该处理超时', async () => {
      const proc = new EventEmitter() as any;
      proc.stdin = new Writable({ write(c, e, cb) { cb(); }, final(cb) { cb(); } });
      proc.stdout = new Readable({ read() {} }); // 永不结束
      proc.stderr = new Readable({ read() {} });
      proc.kill = vi.fn(() => {
        setTimeout(() => proc.emit('close', null), 5);
      });
      mockSpawn.mockReturnValueOnce(proc);

      server = new ClaudeCLIServer({ responseTimeout: 100 });
      await expect(server.sendMessage('ch-1', 'hi')).rejects.toThrow('超时');
    });

    it('应该处理无效 JSON 输出', async () => {
      const proc = new EventEmitter() as any;
      proc.stdin = new Writable({ write(c, e, cb) { cb(); }, final(cb) { cb(); } });
      proc.stdout = new Readable({
        read() { this.push('not json at all'); this.push(null); },
      });
      proc.stderr = new Readable({ read() { this.push(null); } });
      proc.kill = vi.fn();
      setTimeout(() => proc.emit('close', 0), 10);
      mockSpawn.mockReturnValueOnce(proc);

      server = new ClaudeCLIServer();
      await expect(server.sendMessage('ch-1', 'hi')).rejects.toThrow('JSON 解析失败');
    });
  });

  describe('session 管理', () => {
    it('clearSession 应该移除映射', async () => {
      const resp = makeResult('OK', 'session-1');
      mockSpawn.mockReturnValueOnce(createMockProcess(resp));

      server = new ClaudeCLIServer();
      await server.sendMessage('channel-1', 'msg');

      expect(server.getStats().activeSessions).toBe(1);
      server.clearSession('channel-1');
      expect(server.getStats().activeSessions).toBe(0);
    });

    it('destroy 应该清除所有映射', async () => {
      const resp1 = makeResult('OK', 'session-1');
      const resp2 = makeResult('OK', 'session-2');
      mockSpawn
        .mockReturnValueOnce(createMockProcess(resp1))
        .mockReturnValueOnce(createMockProcess(resp2));

      server = new ClaudeCLIServer();
      await server.sendMessage('ch-1', 'msg');
      await server.sendMessage('ch-2', 'msg');

      expect(server.getStats().activeSessions).toBe(2);
      server.destroy();
      expect(server.getStats().activeSessions).toBe(0);
    });
  });

  describe('hasSession', () => {
    it('应该在有 session 时返回 true', async () => {
      const resp = makeResult('OK', 'session-1');
      mockSpawn.mockReturnValueOnce(createMockProcess(resp));

      server = new ClaudeCLIServer();
      await server.sendMessage('channel-1', 'msg');

      expect(server.hasSession('channel-1')).toBe(true);
      expect(server.hasSession('channel-2')).toBe(false);
    });
  });

  describe('session 持久化', () => {
    it('无 persistPath 时不报错', async () => {
      const resp = makeResult('OK', 'session-1');
      mockSpawn.mockReturnValueOnce(createMockProcess(resp));

      server = new ClaudeCLIServer();
      await server.sendMessage('channel-1', 'msg');
      // 无 persistPath，saveSessionMap 应该是 no-op
      expect(server.hasSession('channel-1')).toBe(true);
    });
  });

  describe('getStats', () => {
    it('应该返回正确的状态', async () => {
      const resp = makeResult('OK', 'session-abc');
      mockSpawn.mockReturnValueOnce(createMockProcess(resp));

      server = new ClaudeCLIServer();
      await server.sendMessage('channel-1', 'msg');

      const stats = server.getStats();
      expect(stats.activeSessions).toBe(1);
      expect(stats.sessions).toHaveLength(1);
      expect(stats.sessions[0].channelId).toBe('channel-1');
      expect(stats.sessions[0].sessionId).toBe('session-abc');
    });
  });
});
