import { Client, WSClient, EventDispatcher, Domain } from '@larksuiteoapi/node-sdk';
import type { Channel, MessageTarget, OutboundMessage, CardContent, InboundEvent } from '../types.js';
import { parseFeishuMessage } from './events.js';
import { sendTextMessage, sendCardMessage, updateCardMessage, replyMessage } from './send.js';
import { createLogger } from '../../utils/logger.js';
import type { FeishuConfig } from '../../core/config.js';

const logger = createLogger('feishu:channel');

/** Reconnection config */
const INITIAL_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 60_000;
const BACKOFF_MULTIPLIER = 2;

export class FeishuChannel implements Channel {
  readonly name = 'feishu';

  private client: Client;
  private wsClient: WSClient | null = null;
  private readonly config: FeishuConfig;
  private readonly domain: typeof Domain.Feishu | typeof Domain.Lark;
  private handlers: Array<(event: InboundEvent) => void> = [];
  private connected = false;
  private shouldReconnect = true;
  private retryDelay = INITIAL_RETRY_DELAY_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: FeishuConfig) {
    this.config = config;
    this.domain = config.domain === 'lark' ? Domain.Lark : Domain.Feishu;

    this.client = new Client({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: this.domain,
    });
  }

  async connect(): Promise<void> {
    this.shouldReconnect = true;
    await this.connectInternal();
  }

  private async connectInternal(): Promise<void> {
    // Clean up previous WSClient if any
    if (this.wsClient) {
      try {
        this.wsClient.close({ force: true });
      } catch {
        // ignore
      }
      this.wsClient = null;
    }

    this.wsClient = new WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: this.domain,
    });

    const dispatcher = new EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        try {
          const msg = parseFeishuMessage(data);
          if (!msg) return;
          logger.debug('Received message', { id: msg.id, chatId: msg.chatId });
          for (const handler of this.handlers) {
            handler(msg);
          }
        } catch (err) {
          logger.error('Error handling message event', String(err));
        }
      },
    });

    logger.info('Connecting to Feishu WebSocket...');

    try {
      await this.wsClient.start({ eventDispatcher: dispatcher });
      this.connected = true;
      this.retryDelay = INITIAL_RETRY_DELAY_MS; // Reset backoff on success
      logger.info('Feishu WebSocket connected');
    } catch (err) {
      this.connected = false;
      logger.error('Feishu WebSocket connection failed', String(err));
      this.scheduleReconnect();
    }

    // Monitor for unexpected disconnection
    this.monitorConnection();
  }

  /**
   * Monitor the WebSocket connection and trigger reconnect on disconnect.
   */
  private monitorConnection(): void {
    if (!this.wsClient) return;

    // Poll connection state periodically (WSClient doesn't expose disconnect events directly)
    const checkInterval = setInterval(() => {
      if (!this.shouldReconnect) {
        clearInterval(checkInterval);
        return;
      }

      // If we think we're connected but the WSClient is dead, reconnect
      if (this.connected && this.wsClient) {
        // WSClient doesn't have a public isAlive check, so we rely on errors during send
        // The reconnect will be triggered by send failures
      }
    }, 30_000);

    // Unref so it doesn't keep process alive
    if (typeof checkInterval === 'object' && 'unref' in checkInterval) {
      (checkInterval as NodeJS.Timeout).unref();
    }
  }

  /**
   * Schedule a reconnect attempt with exponential backoff.
   */
  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;

    logger.info(`Scheduling reconnect in ${this.retryDelay}ms`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.shouldReconnect) return;

      logger.info('Attempting to reconnect...');
      try {
        await this.connectInternal();
      } catch (err) {
        logger.error('Reconnect attempt failed', String(err));
        // connectInternal will call scheduleReconnect on failure
      }
    }, this.retryDelay);

    // Exponential backoff
    this.retryDelay = Math.min(this.retryDelay * BACKOFF_MULTIPLIER, MAX_RETRY_DELAY_MS);

    // Unref so it doesn't keep process alive
    if (this.reconnectTimer && typeof this.reconnectTimer === 'object' && 'unref' in this.reconnectTimer) {
      (this.reconnectTimer as NodeJS.Timeout).unref();
    }
  }

  async disconnect(): Promise<void> {
    this.shouldReconnect = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.wsClient) {
      this.wsClient.close({ force: false });
      this.wsClient = null;
    }

    this.connected = false;
    logger.info('Feishu WebSocket disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  onMessage(handler: (event: InboundEvent) => void): void {
    this.handlers.push(handler);
  }

  async sendMessage(target: MessageTarget, content: OutboundMessage): Promise<string> {
    try {
      if (content.replyToMessageId) {
        return await replyMessage(this.client, content.replyToMessageId, content.text);
      }
      return await sendTextMessage(this.client, target.chatId, content.text);
    } catch (err) {
      // If send fails, mark as disconnected and trigger reconnect
      logger.error('Send message failed, triggering reconnect', String(err));
      this.connected = false;
      this.scheduleReconnect();
      throw err;
    }
  }

  async sendCard(target: MessageTarget, card: CardContent): Promise<string> {
    try {
      return await sendCardMessage(this.client, target.chatId, card);
    } catch (err) {
      logger.error('Send card failed', String(err));
      throw err;
    }
  }

  async updateCard(messageId: string, card: CardContent): Promise<void> {
    await updateCardMessage(this.client, messageId, card, true);
  }
}
