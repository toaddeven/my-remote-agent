import type { AppConfig } from './config.js';
import { FeishuChannel } from '../channels/feishu/channel.js';
import type { Channel } from '../channels/types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('app');

export class App {
  private config: AppConfig;
  private channels: Channel[] = [];

  constructor(config: AppConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    logger.info('Starting MyAgent...');

    const feishu = new FeishuChannel(this.config.feishu);

    feishu.onMessage((event) => {
      logger.info('Inbound message', {
        id: event.id,
        chatId: event.chatId,
        userId: event.userId,
        peerKind: event.peerKind,
        text: event.text.slice(0, 80),
      });
    });

    await feishu.connect();
    this.channels.push(feishu);

    logger.info('MyAgent started');
  }

  async stop(): Promise<void> {
    logger.info('Stopping MyAgent...');
    await Promise.all(this.channels.map((ch) => ch.disconnect()));
    this.channels = [];
    logger.info('MyAgent stopped');
  }
}
