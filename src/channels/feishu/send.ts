import type { Client } from '@larksuiteoapi/node-sdk';
import { buildTextCard, buildStreamingCard } from './card.js';
import type { CardContent } from '../types.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('feishu:send');

export async function sendTextMessage(
  client: Client,
  chatId: string,
  text: string,
): Promise<string> {
  const res = await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
  });

  if (res.code !== 0) {
    throw new Error(`Failed to send text message: ${res.msg} (code=${res.code})`);
  }

  const messageId = res.data?.message_id ?? '';
  logger.debug('Sent text message', { chatId, messageId });
  return messageId;
}

export async function sendCardMessage(
  client: Client,
  chatId: string,
  card: CardContent,
): Promise<string> {
  const cardObj = buildTextCard(card.body, card.title);

  const res = await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: 'interactive',
      content: JSON.stringify(cardObj),
    },
  });

  if (res.code !== 0) {
    throw new Error(`Failed to send card message: ${res.msg} (code=${res.code})`);
  }

  const messageId = res.data?.message_id ?? '';
  logger.debug('Sent card message', { chatId, messageId });
  return messageId;
}

export async function updateCardMessage(
  client: Client,
  messageId: string,
  card: CardContent,
  done = false,
): Promise<void> {
  const cardObj = buildStreamingCard(card.body, done);

  const res = await client.im.message.patch({
    path: { message_id: messageId },
    data: { content: JSON.stringify(cardObj) },
  });

  if (res.code !== 0) {
    throw new Error(`Failed to update card message: ${res.msg} (code=${res.code})`);
  }

  logger.debug('Updated card message', { messageId });
}

export async function replyMessage(
  client: Client,
  messageId: string,
  text: string,
): Promise<string> {
  const res = await client.im.message.reply({
    path: { message_id: messageId },
    data: {
      content: JSON.stringify({ text }),
      msg_type: 'text',
    },
  });

  if (res.code !== 0) {
    throw new Error(`Failed to reply to message: ${res.msg} (code=${res.code})`);
  }

  const replyId = res.data?.message_id ?? '';
  logger.debug('Replied to message', { messageId, replyId });
  return replyId;
}
