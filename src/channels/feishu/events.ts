import type { InboundMessage } from '../types.js';
import { extractMentions } from './mention.js';

interface FeishuMessageContent {
  text?: string;
  mentions?: Array<{ key: string; id: { open_id?: string; user_id?: string } }>;
}

interface FeishuMessageEvent {
  message_id: string;
  chat_id: string;
  chat_type: string;
  sender: {
    sender_id: {
      open_id?: string;
      user_id?: string;
    };
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    create_time: string;
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: {
        open_id?: string;
        user_id?: string;
      };
      name?: string;
    }>;
  };
}

function safeParseContent(raw: string): FeishuMessageContent {
  try {
    return JSON.parse(raw) as FeishuMessageContent;
  } catch {
    return {};
  }
}

function extractText(content: FeishuMessageContent): string {
  if (typeof content.text === 'string') {
    return content.text;
  }
  return '';
}

export function parseFeishuMessage(event: unknown): InboundMessage | null {
  if (!event || typeof event !== 'object') return null;

  const ev = event as Record<string, unknown>;

  // The SDK wraps events; handle both raw and wrapped formats
  const messageEvent = (ev['message'] ? ev : ev['event'] ? (ev['event'] as Record<string, unknown>) : ev) as Partial<FeishuMessageEvent>;

  const message = messageEvent.message;
  if (!message) return null;

  const messageId = message.message_id;
  const chatId = message.chat_id;
  const chatType = message.chat_type;
  const createTime = message.create_time;
  const messageType = message.message_type;

  if (!messageId || !chatId) return null;

  // Only handle text messages
  if (messageType !== 'text') return null;

  const sender = messageEvent.sender;
  const userId = sender?.sender_id?.open_id ?? sender?.sender_id?.user_id ?? '';
  if (!userId) return null;

  const content = safeParseContent(message.content ?? '{}');
  const rawText = extractText(content);
  const mentions = extractMentions(message.mentions);
  const peerKind: 'direct' | 'group' = chatType === 'p2p' ? 'direct' : 'group';
  const timestamp = parseInt(createTime ?? '0', 10) || Date.now();

  return {
    id: messageId,
    chatId,
    userId,
    text: rawText,
    mentions,
    timestamp,
    channelName: 'feishu',
    peerKind,
  };
}
