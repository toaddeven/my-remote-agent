/**
 * Session Mock 工厂
 * 模拟会话管理和 JSONL 存储
 */
import { vi } from 'vitest';

export interface MockMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface MockSession {
  key: string;
  agentId: string;
  channelName: string;
  chatType: 'private' | 'group';
  peerId: string;
  transcript: MockMessage[];
  createdAt: number;
  lastActiveAt: number;
}

/** 创建 Mock Session */
export function createMockSession(overrides: Partial<MockSession> = {}): MockSession {
  const now = Date.now();
  return {
    key: 'agent:main:feishu:dm:ou_test_user',
    agentId: 'main',
    channelName: 'feishu',
    chatType: 'private',
    peerId: 'ou_test_user',
    transcript: [],
    createdAt: now,
    lastActiveAt: now,
    ...overrides,
  };
}

/** 创建群聊 Mock Session */
export function createGroupSession(chatId: string = 'oc_test_group'): MockSession {
  return createMockSession({
    key: `agent:main:feishu:group:${chatId}`,
    chatType: 'group',
    peerId: chatId,
  });
}

/** 创建带历史消息的 Session */
export function createSessionWithHistory(messages: Array<{ role: 'user' | 'assistant'; content: string }>): MockSession {
  const session = createMockSession();
  session.transcript = messages.map((m, i) => ({
    ...m,
    timestamp: Date.now() - (messages.length - i) * 1000,
  }));
  return session;
}

/** Mock Session Manager */
export function createMockSessionManager() {
  const sessions = new Map<string, MockSession>();

  return {
    get: vi.fn((key: string) => sessions.get(key) || null),
    create: vi.fn((key: string, data: Partial<MockSession>) => {
      const session = createMockSession({ key, ...data });
      sessions.set(key, session);
      return session;
    }),
    save: vi.fn(),
    delete: vi.fn((key: string) => sessions.delete(key)),
    list: vi.fn(() => Array.from(sessions.values())),
    addMessage: vi.fn((key: string, message: MockMessage) => {
      const session = sessions.get(key);
      if (session) {
        session.transcript.push(message);
        session.lastActiveAt = Date.now();
      }
    }),
    _sessions: sessions, // 测试内部访问
  };
}

/** 模拟 JSONL 文件内容 */
export function createJsonlContent(messages: MockMessage[]): string {
  return messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
}

/** 模拟损坏的 JSONL（含坏行） */
export function createCorruptedJsonl(messages: MockMessage[]): string {
  const lines = messages.map((m) => JSON.stringify(m));
  // 在中间插入坏行
  lines.splice(Math.floor(lines.length / 2), 0, '{corrupt json here');
  return lines.join('\n') + '\n';
}
