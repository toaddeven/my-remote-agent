/**
 * 飞书 Channel Mock 工厂
 * 模拟飞书 WebSocket 连接和 REST API
 */
import { vi } from 'vitest';
import { EventEmitter } from 'events';

/** 模拟 WebSocket 连接 */
export class MockWebSocket extends EventEmitter {
  readyState = 1; // OPEN
  sent: string[] = [];

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3; // CLOSED
    this.emit('close');
  }

  // 模拟收到消息
  simulateMessage(data: unknown) {
    this.emit('message', JSON.stringify(data));
  }

  // 模拟断连
  simulateDisconnect() {
    this.readyState = 3;
    this.emit('close');
  }

  // 模拟错误
  simulateError(error: Error) {
    this.emit('error', error);
  }
}

/** 模拟飞书事件 */
export function createFeishuTextEvent(options: {
  messageId?: string;
  chatId?: string;
  chatType?: 'p2p' | 'group';
  senderId?: string;
  senderName?: string;
  text?: string;
  mentions?: Array<{ id: { open_id: string }; name: string }>;
}) {
  return {
    type: 'event',
    header: {
      event_type: 'im.message.receive_v1',
      event_id: options.messageId || `evt_${Date.now()}`,
    },
    event: {
      message: {
        message_id: options.messageId || `om_${Date.now()}`,
        chat_id: options.chatId || 'oc_test_chat',
        chat_type: options.chatType || 'p2p',
        content: JSON.stringify({ text: options.text || 'hello' }),
        message_type: 'text',
        mentions: options.mentions || [],
      },
      sender: {
        sender_id: { open_id: options.senderId || 'ou_test_user' },
        sender_type: 'user',
        tenant_key: 'test_tenant',
      },
    },
  };
}

/** 模拟飞书 REST API 客户端 */
export function createMockFeishuClient() {
  return {
    getWebSocketUrl: vi.fn().mockResolvedValue('wss://mock.feishu.cn/ws'),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 'om_reply_123' }),
    sendCard: vi.fn().mockResolvedValue({ message_id: 'om_card_123' }),
    updateCard: vi.fn().mockResolvedValue(undefined),
    getAccessToken: vi.fn().mockResolvedValue('t-mock-token'),
  };
}

/** 模拟 ping 事件 */
export function createPingEvent() {
  return { type: 'ping' };
}
