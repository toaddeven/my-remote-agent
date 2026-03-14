/**
 * ACP Manager 单元测试
 * 对应 TEST_PLAN: ACP-001 ~ ACP-007
 */
import { describe, it, expect, beforeEach } from 'vitest';

/** ACP Session 接口（与 PRD 第13.4章一致） */
interface AcpSession {
  id: string;
  agentId: string;
  status: 'running' | 'idle' | 'completed' | 'failed';
  cwd?: string;
  createdAt: number;
  lastActiveAt: number;
}

interface SpawnOptions {
  agentId: string;
  mode: 'oneshot' | 'session' | 'persistent';
  cwd?: string;
  prompt?: string;
}

/**
 * 简易 ACP Manager 实现（用于测试逻辑验证）
 * 实际开发完成后替换为 import 真实模块
 */
class MockAcpManager {
  private sessions: Map<string, AcpSession> = new Map();
  private maxConcurrent: number;
  private allowedPaths: string[];
  private sessionTimeout: number;

  constructor(options: {
    maxConcurrentSessions?: number;
    allowedPaths?: string[];
    sessionTimeout?: number;
  } = {}) {
    this.maxConcurrent = options.maxConcurrentSessions ?? 8;
    this.allowedPaths = options.allowedPaths ?? [];
    this.sessionTimeout = options.sessionTimeout ?? 300000;
  }

  async spawn(options: SpawnOptions): Promise<AcpSession> {
    // 并发限制
    const activeCount = [...this.sessions.values()].filter(
      (s) => s.status === 'running' || s.status === 'idle',
    ).length;

    if (activeCount >= this.maxConcurrent) {
      throw new Error(`Max concurrent sessions (${this.maxConcurrent}) exceeded`);
    }

    // cwd 白名单验证
    if (options.cwd && this.allowedPaths.length > 0) {
      const normalized = options.cwd.replace(/^~/, '/Users/test');
      const allowed = this.allowedPaths.some((p) => {
        const normalizedAllowed = p.replace(/^~/, '/Users/test');
        return normalized.startsWith(normalizedAllowed);
      });
      if (!allowed) {
        throw new Error(`Path ${options.cwd} is not in allowed paths`);
      }
    }

    const session: AcpSession = {
      id: `acp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      agentId: options.agentId,
      status: 'running',
      cwd: options.cwd,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };

    this.sessions.set(session.id, session);
    return session;
  }

  list(filter?: { status?: string }): AcpSession[] {
    const all = [...this.sessions.values()];
    if (filter?.status) {
      return all.filter((s) => s.status === filter.status);
    }
    return all;
  }

  async send(sessionId: string, message: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (session.status !== 'running' && session.status !== 'idle') {
      throw new Error(`Session ${sessionId} is not active`);
    }
    session.lastActiveAt = Date.now();
  }

  async kill(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.status = 'completed';
  }

  /** 清理超时会话 */
  cleanupExpired(): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, session] of this.sessions) {
      if (
        (session.status === 'running' || session.status === 'idle') &&
        now - session.lastActiveAt > this.sessionTimeout
      ) {
        session.status = 'completed';
        cleaned++;
      }
    }
    return cleaned;
  }
}

describe('ACP Manager', () => {
  let manager: MockAcpManager;

  beforeEach(() => {
    manager = new MockAcpManager({
      maxConcurrentSessions: 3,
      allowedPaths: ['~/work', '~/projects'],
      sessionTimeout: 1000, // 1s for tests
    });
  });

  // ACP-001: spawn 会话
  it('should spawn a new ACP session', async () => {
    const session = await manager.spawn({
      agentId: 'claude',
      mode: 'oneshot',
      cwd: '~/work/my-project',
      prompt: 'Fix the bug',
    });

    expect(session.id).toBeDefined();
    expect(session.agentId).toBe('claude');
    expect(session.status).toBe('running');
    expect(session.cwd).toBe('~/work/my-project');
    expect(session.createdAt).toBeGreaterThan(0);
  });

  // ACP-002: list 活跃会话
  it('should list active sessions', async () => {
    await manager.spawn({ agentId: 'claude', mode: 'oneshot' });
    await manager.spawn({ agentId: 'codex', mode: 'session' });

    const sessions = manager.list();
    expect(sessions).toHaveLength(2);

    const running = manager.list({ status: 'running' });
    expect(running).toHaveLength(2);
  });

  // ACP-003: send 消息到会话
  it('should send message to active session', async () => {
    const session = await manager.spawn({ agentId: 'claude', mode: 'session' });

    await expect(manager.send(session.id, 'Update the readme')).resolves.toBeUndefined();
  });

  it('should reject send to non-existent session', async () => {
    await expect(manager.send('nonexistent', 'hello')).rejects.toThrow(/not found/);
  });

  it('should reject send to completed session', async () => {
    const session = await manager.spawn({ agentId: 'claude', mode: 'oneshot' });
    await manager.kill(session.id);

    await expect(manager.send(session.id, 'hello')).rejects.toThrow(/not active/);
  });

  // ACP-004: kill 会话
  it('should kill session and set status to completed', async () => {
    const session = await manager.spawn({ agentId: 'claude', mode: 'session' });

    await manager.kill(session.id);

    const sessions = manager.list({ status: 'running' });
    expect(sessions).toHaveLength(0);

    const all = manager.list();
    expect(all[0].status).toBe('completed');
  });

  it('should reject kill for non-existent session', async () => {
    await expect(manager.kill('nonexistent')).rejects.toThrow(/not found/);
  });

  // ACP-005: 并发限制
  it('should enforce max concurrent sessions', async () => {
    await manager.spawn({ agentId: 'claude', mode: 'oneshot' });
    await manager.spawn({ agentId: 'claude', mode: 'oneshot' });
    await manager.spawn({ agentId: 'claude', mode: 'oneshot' });

    // 第 4 个应该被拒绝
    await expect(
      manager.spawn({ agentId: 'claude', mode: 'oneshot' }),
    ).rejects.toThrow(/Max concurrent/);
  });

  it('should allow new session after killing one', async () => {
    const s1 = await manager.spawn({ agentId: 'claude', mode: 'oneshot' });
    await manager.spawn({ agentId: 'claude', mode: 'oneshot' });
    await manager.spawn({ agentId: 'claude', mode: 'oneshot' });

    await manager.kill(s1.id);

    // 现在应该可以创建新的
    const s4 = await manager.spawn({ agentId: 'claude', mode: 'oneshot' });
    expect(s4.status).toBe('running');
  });

  // ACP-006: 超时自动清理
  it('should cleanup expired sessions', async () => {
    const session = await manager.spawn({ agentId: 'claude', mode: 'oneshot' });

    // 模拟超时：修改 lastActiveAt
    const s = manager.list().find((s) => s.id === session.id)!;
    s.lastActiveAt = Date.now() - 2000; // 2s ago, timeout is 1s

    const cleaned = manager.cleanupExpired();
    expect(cleaned).toBe(1);

    const running = manager.list({ status: 'running' });
    expect(running).toHaveLength(0);
  });

  // ACP-007: cwd 白名单验证
  it('should allow cwd in whitelist', async () => {
    const session = await manager.spawn({
      agentId: 'claude',
      mode: 'oneshot',
      cwd: '~/work/my-project',
    });
    expect(session.status).toBe('running');
  });

  it('should reject cwd not in whitelist', async () => {
    await expect(
      manager.spawn({
        agentId: 'claude',
        mode: 'oneshot',
        cwd: '~/secret/data',
      }),
    ).rejects.toThrow(/not in allowed paths/);
  });

  it('should allow any cwd when allowedPaths is empty', async () => {
    const openManager = new MockAcpManager({ allowedPaths: [] });
    const session = await openManager.spawn({
      agentId: 'claude',
      mode: 'oneshot',
      cwd: '/anywhere',
    });
    expect(session.status).toBe('running');
  });

  it('should allow spawn without cwd', async () => {
    const session = await manager.spawn({
      agentId: 'claude',
      mode: 'oneshot',
    });
    expect(session.cwd).toBeUndefined();
    expect(session.status).toBe('running');
  });
});
