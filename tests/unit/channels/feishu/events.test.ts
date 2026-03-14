/**
 * 飞书事件解析单元测试
 * 对应 TEST_PLAN: FSH-003 ~ FSH-006, FSH-012
 */
import { describe, it, expect } from 'vitest';
import { parseFeishuMessage } from '../../../../src/channels/feishu/events.js';
import { createFeishuTextEvent } from '../../../utils/mock-feishu.js';

describe('Feishu Event Parsing', () => {
  // FSH-003: 收到文本消息事件
  it('should parse text message event into InboundMessage', () => {
    const event = createFeishuTextEvent({
      messageId: 'om_msg_001',
      chatId: 'oc_chat_001',
      chatType: 'p2p',
      senderId: 'ou_user_001',
      text: '你好',
    });

    const result = parseFeishuMessage(event.event);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('om_msg_001');
    expect(result!.chatId).toBe('oc_chat_001');
    expect(result!.userId).toBe('ou_user_001');
    expect(result!.text).toBe('你好');
    expect(result!.peerKind).toBe('direct');
    expect(result!.channelName).toBe('feishu');
  });

  // FSH-004: 收到 @提及消息
  it('should parse mentions from message event', () => {
    const event = createFeishuTextEvent({
      messageId: 'om_msg_002',
      chatId: 'oc_chat_002',
      chatType: 'group',
      senderId: 'ou_user_002',
      text: '@MyAgent 帮我查一下',
      mentions: [{ id: { open_id: 'ou_bot_001' }, name: 'MyAgent' }],
    });

    const result = parseFeishuMessage(event.event);
    expect(result).not.toBeNull();
    expect(result!.peerKind).toBe('group');
    expect(result!.mentions).toContain('ou_bot_001');
  });

  // FSH-005: 群消息无 @提及
  it('should parse group message without mentions', () => {
    const event = createFeishuTextEvent({
      chatId: 'oc_chat_003',
      chatType: 'group',
      senderId: 'ou_user_003',
      text: '随便说说',
    });

    const result = parseFeishuMessage(event.event);
    expect(result).not.toBeNull();
    expect(result!.peerKind).toBe('group');
    expect(result!.mentions).toHaveLength(0);
  });

  // FSH-012: 消息去重（验证 message_id 唯一性）
  it('should return consistent message_id for dedup', () => {
    const event = createFeishuTextEvent({
      messageId: 'om_dedup_001',
      text: 'test dedup',
    });

    const result1 = parseFeishuMessage(event.event);
    const result2 = parseFeishuMessage(event.event);

    expect(result1!.id).toBe(result2!.id);
    expect(result1!.id).toBe('om_dedup_001');
  });

  // 边界：null/undefined 输入
  it('should return null for null input', () => {
    expect(parseFeishuMessage(null)).toBeNull();
    expect(parseFeishuMessage(undefined)).toBeNull();
  });

  // 边界：缺少 message 字段
  it('should return null for event without message field', () => {
    expect(parseFeishuMessage({ sender: {} })).toBeNull();
  });

  // 边界：缺少 sender
  it('should return null for event without sender', () => {
    const event = {
      message: {
        message_id: 'om_no_sender',
        chat_id: 'oc_chat',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
      },
    };
    expect(parseFeishuMessage(event)).toBeNull();
  });

  // 边界：非文本消息类型
  it('should return null for non-text message types', () => {
    const event = {
      message: {
        message_id: 'om_image',
        chat_id: 'oc_chat',
        chat_type: 'p2p',
        message_type: 'image',
        content: '{}',
      },
      sender: {
        sender_id: { open_id: 'ou_user' },
      },
    };
    expect(parseFeishuMessage(event)).toBeNull();
  });

  // 边界：content JSON 解析失败
  it('should handle malformed content JSON gracefully', () => {
    const event = {
      message: {
        message_id: 'om_bad_json',
        chat_id: 'oc_chat',
        chat_type: 'p2p',
        message_type: 'text',
        content: '{ bad json }',
      },
      sender: {
        sender_id: { open_id: 'ou_user' },
      },
    };

    const result = parseFeishuMessage(event);
    expect(result).not.toBeNull();
    expect(result!.text).toBe(''); // safeParseContent returns {}
  });
});
