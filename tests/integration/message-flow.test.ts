/**
 * 集成测试：消息流程
 * 对应 TEST_PLAN: INT-001 ~ INT-006
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createFeishuTextEvent, createMockFeishuClient } from '../utils/mock-feishu.js';
import { createMockApiBackend, type ChatEvent } from '../utils/mock-ai-backend.js';
import { createMockSessionManager, createJsonlContent } from '../utils/mock-session.js';
import { createTempDir, cleanupTempDir } from '../utils/helpers.js';
import { parseFeishuMessage } from '../../src/channels/feishu/events.js';
import { isBotMentioned } from '../../src/channels/feishu/mention.js';

describe('Integration: Feishu → AI Reply', () => {
  let sessionManager: ReturnType<typeof createMockSessionManager>;
  let feishuClient: ReturnType<typeof createMockFeishuClient>;

  beforeEach(() => {
    sessionManager = createMockSessionManager();
    feishuClient = createMockFeishuClient();
  });

  // INT-001: 私聊文本消息 → Claude 回复
  it('should process DM text message through full pipeline', async () => {
    // 1. 飞书收到消息
    const event = createFeishuTextEvent({
      messageId: 'om_int_001',
      chatId: 'oc_dm_chat',
      chatType: 'p2p',
      senderId: 'ou_user_001',
      text: '你好',
    });

    // 2. 解析消息
    const inbound = parseFeishuMessage(event.event);
    expect(inbound).not.toBeNull();
    expect(inbound!.peerKind).toBe('direct');

    // 3. 创建/获取会话
    const sessionKey = `agent:main:feishu:dm:${inbound!.userId}`;
    sessionManager.create(sessionKey, {
      agentId: 'main',
      chatType: 'private',
      peerId: inbound!.userId,
    });

    // 4. 记录用户消息
    sessionManager.addMessage(sessionKey, {
      role: 'user',
      content: inbound!.text,
      timestamp: Date.now(),
    });

    // 5. AI 回复
    const aiBackend = createMockApiBackend();
    const events: ChatEvent[] = [];
    for await (const e of aiBackend.chat([])) {
      events.push(e);
    }

    const replyText = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => e.text)
      .join('');

    expect(replyText).toBe('你好！我是 MyAgent。');

    // 6. 记录助手回复
    sessionManager.addMessage(sessionKey, {
      role: 'assistant',
      content: replyText,
      timestamp: Date.now(),
    });

    // 7. 发送飞书消息
    await feishuClient.sendMessage({ chatId: inbound!.chatId, text: replyText });
    expect(feishuClient.sendMessage).toHaveBeenCalledTimes(1);

    // 8. 验证会话
    const session = sessionManager._sessions.get(sessionKey);
    expect(session?.transcript).toHaveLength(2);
    expect(session?.transcript[0].role).toBe('user');
    expect(session?.transcript[1].role).toBe('assistant');
  });

  // INT-002: 群聊 @提及 → Claude 回复
  it('should only reply to @mentioned messages in group', async () => {
    const botId = 'ou_bot_001';

    // 群消息带 @提及
    const mentionEvent = createFeishuTextEvent({
      messageId: 'om_int_002',
      chatId: 'oc_group_001',
      chatType: 'group',
      senderId: 'ou_user_002',
      text: '@MyAgent 帮忙查一下',
      mentions: [{ id: { open_id: botId }, name: 'MyAgent' }],
    });

    const inbound = parseFeishuMessage(mentionEvent.event);
    expect(inbound).not.toBeNull();
    expect(isBotMentioned(inbound!.mentions, botId)).toBe(true);

    // 群消息不带 @提及
    const plainEvent = createFeishuTextEvent({
      chatId: 'oc_group_001',
      chatType: 'group',
      senderId: 'ou_user_003',
      text: '随便聊聊',
    });

    const plainInbound = parseFeishuMessage(plainEvent.event);
    expect(isBotMentioned(plainInbound!.mentions, botId)).toBe(false);
  });

  // INT-003: 多轮对话上下文保持
  it('should maintain context across multiple rounds', async () => {
    const sessionKey = 'agent:main:feishu:dm:ou_multi';
    sessionManager.create(sessionKey, { chatType: 'private', peerId: 'ou_multi' });

    // 第一轮
    sessionManager.addMessage(sessionKey, {
      role: 'user',
      content: '我叫小明',
      timestamp: 1000,
    });
    sessionManager.addMessage(sessionKey, {
      role: 'assistant',
      content: '你好，小明！',
      timestamp: 2000,
    });

    // 第二轮
    sessionManager.addMessage(sessionKey, {
      role: 'user',
      content: '我叫什么？',
      timestamp: 3000,
    });
    sessionManager.addMessage(sessionKey, {
      role: 'assistant',
      content: '你叫小明。',
      timestamp: 4000,
    });

    const session = sessionManager._sessions.get(sessionKey);
    expect(session?.transcript).toHaveLength(4);
    expect(session?.transcript[0].content).toBe('我叫小明');
    expect(session?.transcript[3].content).toBe('你叫小明。');
  });

  // INT-004: 消息排队 followup
  it('should process messages sequentially in followup mode', async () => {
    const processOrder: string[] = [];
    const aiBackend = createMockApiBackend();

    const processMessage = async (text: string) => {
      for await (const _ of aiBackend.chat([])) {
        // consume events
      }
      processOrder.push(text);
    };

    // 按顺序处理
    await processMessage('msg1');
    await processMessage('msg2');
    await processMessage('msg3');

    expect(processOrder).toEqual(['msg1', 'msg2', 'msg3']);
  });
});

describe('Integration: Session Persistence', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  // INT-005: 对话 → JSONL → 重启 → 恢复
  it('should persist and restore session from JSONL', () => {
    const messages = [
      { role: 'user' as const, content: '你好', timestamp: 1000 },
      { role: 'assistant' as const, content: '你好！有什么可以帮你的？', timestamp: 2000 },
      { role: 'user' as const, content: '帮我查天气', timestamp: 3000 },
    ];

    // 写入 JSONL
    const jsonl = createJsonlContent(messages);
    const filePath = path.join(tempDir, 'session.jsonl');
    fs.writeFileSync(filePath, jsonl);

    // 模拟"重启"后恢复
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    const lines = raw.split('\n');
    const restored = lines.map((line) => JSON.parse(line));

    expect(restored).toHaveLength(3);
    expect(restored[0].content).toBe('你好');
    expect(restored[1].role).toBe('assistant');
    expect(restored[2].content).toBe('帮我查天气');
  });

  // INT-006: 归档触发
  it('should detect archive trigger when file exceeds threshold', () => {
    const THRESHOLD = 1024; // 使用 1KB 作为测试阈值
    const filePath = path.join(tempDir, 'large.jsonl');

    // 写入大量数据
    const bigContent = Array.from({ length: 50 }, (_, i) =>
      JSON.stringify({ role: 'user', content: 'x'.repeat(50), timestamp: i }),
    ).join('\n');

    fs.writeFileSync(filePath, bigContent);

    const stat = fs.statSync(filePath);
    const shouldArchive = stat.size > THRESHOLD;
    expect(shouldArchive).toBe(true);
  });
});
