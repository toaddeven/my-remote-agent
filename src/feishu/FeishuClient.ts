// @ts-nocheck
// 飞书集成 - 长连接模式 (WSClient)
// 支持文本、图片、文件、视频、音频消息的接收与发送
import { Client, WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';
import { FeishuConfig, FeishuAccountConfig } from '../types/index.js';
import { logger } from '../utils/index.js';
import * as fs from 'fs';
import * as path from 'path';

// 文件附件信息
export interface FileAttachment {
  type: 'image' | 'file' | 'video' | 'audio';
  key: string;        // file_key 或 image_key
  name?: string;      // 文件名
  size?: number;      // 文件大小（字节）
  duration?: number;  // 音频/视频时长（毫秒）
  localPath?: string; // 下载后的本地路径
}

export interface FeishuMessage {
  messageId: string;
  chatId: string;
  chatType: string;
  userId: string;
  content: string;
  timestamp: number;
  messageType: string;
  attachments?: FileAttachment[]; // 文件附件
}

export type MessageHandler = (message: FeishuMessage) => Promise<void>;

// 文件存储目录
const UPLOAD_DIR = './data/uploads';

export class FeishuClient {
  private config: FeishuConfig;
  private client: InstanceType<typeof Client>;
  private wsClient: WSClient;
  private eventDispatcher: EventDispatcher;
  private messageHandler?: MessageHandler;

  constructor(config: FeishuConfig) {
    this.config = config;

    // 确保上传目录存在
    if (!fs.existsSync(UPLOAD_DIR)) {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    }

    // 初始化飞书 API Client（自动管理 tenant_access_token）
    this.client = new Client({
      appId: config.appId,
      appSecret: config.appSecret,
    });

    // 初始化事件分发器
    this.eventDispatcher = new EventDispatcher({});

    // 注册消息接收事件
    this.eventDispatcher.register({
      'im.message.receive_v1': (data) => {
        this.handleMessageEvent(data);
      },
    });

    // 初始化 WebSocket 长连接客户端
    this.wsClient = new WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      loggerLevel: 2, // LoggerLevel.info
    });

    logger.info('Feishu client initialized (long connection mode)');
  }

  // 设置消息处理回调
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  // 启动长连接
  async start(): Promise<void> {
    logger.info('Starting Feishu WebSocket connection...');
    await this.wsClient.start({ eventDispatcher: this.eventDispatcher });
    logger.info('Feishu WebSocket connected');
  }

  // 处理消息事件
  private async handleMessageEvent(data: any): Promise<void> {
    const msg = data.message;
    if (!msg) return;

    let content = '';
    const attachments: FileAttachment[] = [];
    const msgType = msg.message_type;

    try {
      const parsed = JSON.parse(msg.content || '{}');

      switch (msgType) {
        case 'text':
          content = parsed.text || '';
          break;

        case 'image':
          attachments.push({
            type: 'image',
            key: parsed.image_key,
            name: `image_${Date.now()}.png`,
          });
          content = '[图片]';
          break;

        case 'file':
          attachments.push({
            type: 'file',
            key: parsed.file_key,
            name: parsed.file_name || 'unknown_file',
            size: parsed.size,
          });
          content = `[文件] ${parsed.file_name || ''}`;
          break;

        case 'media':
          attachments.push({
            type: 'video',
            key: parsed.file_key,
            name: parsed.file_name || `video_${Date.now()}.mp4`,
            size: parsed.size,
            duration: parsed.duration,
          });
          content = `[视频] ${parsed.file_name || ''}`;
          break;

        case 'audio':
          attachments.push({
            type: 'audio',
            key: parsed.file_key,
            name: `audio_${Date.now()}.opus`,
            duration: parsed.duration,
          });
          content = '[语音]';
          break;

        default:
          // post (富文本)、sticker 等其他类型
          content = parsed.text || parsed.title || JSON.stringify(parsed).substring(0, 200);
          break;
      }
    } catch {
      content = msg.content || '';
    }

    // 下载附件
    for (const att of attachments) {
      try {
        const localPath = await this.downloadResource(msg.message_id, att.key, att.type, att.name);
        att.localPath = localPath;
        logger.info(`附件已下载: ${att.type} → ${localPath}`);
      } catch (err) {
        logger.error(`附件下载失败: ${att.type} (${att.key})`, err);
      }
    }

    const message: FeishuMessage = {
      messageId: msg.message_id,
      chatId: msg.chat_id,
      chatType: msg.chat_type,
      userId: data.sender?.sender_id?.open_id || data.sender?.sender_id?.user_id || '',
      content,
      timestamp: parseInt(msg.create_time) || Date.now(),
      messageType: msgType,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    logger.info(`Message received [${message.chatType}] from ${message.userId}: ${msgType} ${content.substring(0, 80)}`);

    if (this.messageHandler) {
      try {
        await this.messageHandler(message);
      } catch (err) {
        logger.error('Message handler error', err);
      }
    }
  }

  // 下载消息中的资源文件
  async downloadResource(messageId: string, fileKey: string, type: string, filename?: string): Promise<string> {
    const resourceType = type === 'image' ? 'image' : 'file';
    const resp = await this.client.im.messageResource.get({
      path: {
        message_id: messageId,
        file_key: fileKey,
      },
      params: {
        type: resourceType,
      },
    });

    const savePath = path.join(UPLOAD_DIR, `${Date.now()}_${filename || fileKey}`);
    await resp.writeFile(savePath);
    return path.resolve(savePath);
  }

  // 回复消息
  async replyMessage(messageId: string, content: string): Promise<string> {
    const resp = await this.client.im.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify({ text: content }),
        msg_type: 'text',
      },
    });
    return resp?.data?.message_id || '';
  }

  // 发送文本消息
  async sendMessage(receiveId: string, content: string, receiveIdType?: string): Promise<string> {
    if (!receiveIdType) {
      if (receiveId.startsWith('oc_')) receiveIdType = 'chat_id';
      else if (receiveId.startsWith('ou_')) receiveIdType = 'open_id';
      else receiveIdType = 'user_id';
    }
    const resp = await this.client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        content: JSON.stringify({ text: content }),
        msg_type: 'text',
      },
    });
    return resp?.data?.message_id || '';
  }

  // 发送图片消息
  async sendImage(receiveId: string, imagePath: string, receiveIdType?: string): Promise<string> {
    if (!receiveIdType) {
      if (receiveId.startsWith('oc_')) receiveIdType = 'chat_id';
      else if (receiveId.startsWith('ou_')) receiveIdType = 'open_id';
      else receiveIdType = 'user_id';
    }

    // 上传图片
    const uploadResp = await this.client.im.image.create({
      data: {
        image_type: 'message',
        image: fs.createReadStream(imagePath),
      },
    });
    const imageKey = uploadResp?.data?.image_key;
    if (!imageKey) throw new Error('图片上传失败');

    // 发送图片消息
    const resp = await this.client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        content: JSON.stringify({ image_key: imageKey }),
        msg_type: 'image',
      },
    });
    return resp?.data?.message_id || '';
  }

  // 发送文件消息
  async sendFile(receiveId: string, filePath: string, receiveIdType?: string): Promise<string> {
    if (!receiveIdType) {
      if (receiveId.startsWith('oc_')) receiveIdType = 'chat_id';
      else if (receiveId.startsWith('ou_')) receiveIdType = 'open_id';
      else receiveIdType = 'user_id';
    }

    const fileName = path.basename(filePath);
    const fileType = this.getFileType(fileName);

    // 上传文件
    const uploadResp = await this.client.im.file.create({
      data: {
        file_type: fileType,
        file_name: fileName,
        file: fs.createReadStream(filePath),
      },
    });
    const fileKey = uploadResp?.data?.file_key;
    if (!fileKey) throw new Error('文件上传失败');

    // 发送文件消息
    const resp = await this.client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        content: JSON.stringify({ file_key: fileKey }),
        msg_type: 'file',
      },
    });
    return resp?.data?.message_id || '';
  }

  // 根据文件名判断文件类型
  private getFileType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const docExts = ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.pdf'];
    const mediaExts = ['.mp4', '.mov', '.avi', '.mkv'];
    const audioExts = ['.mp3', '.wav', '.ogg', '.opus', '.m4a'];
    if (docExts.includes(ext)) return 'doc';
    if (mediaExts.includes(ext)) return 'mp4';
    if (audioExts.includes(ext)) return 'opus';
    return 'stream';
  }

  // 发送卡片消息
  async sendCard(receiveId: string, cardContent: object, receiveIdType: string = 'open_id'): Promise<string> {
    const resp = await this.client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        content: JSON.stringify(cardContent),
        msg_type: 'interactive',
      },
    });
    return resp?.data?.message_id || '';
  }

  // 获取账号标识
  getAccountId(): string {
    return this.config.appId;
  }

  // 关闭连接
  close(): void {
    this.wsClient.close();
    logger.info('Feishu WebSocket closed');
  }
}

// 多账号飞书客户端 — 管理多个 FeishuClient 实例
export class FeishuMultiClient {
  private clients: FeishuClient[] = [];
  private messageHandler?: MessageHandler;

  constructor(config: FeishuConfig) {
    // 收集所有账号配置
    const accounts: FeishuAccountConfig[] = [];

    // 主账号（向后兼容）
    if (config.appId && config.appSecret) {
      accounts.push({
        id: 'main',
        appId: config.appId,
        appSecret: config.appSecret,
        verificationToken: config.verificationToken,
        encryptKey: config.encryptKey,
      });
    }

    // 额外账号
    if (config.accounts) {
      for (const acc of config.accounts) {
        // 跳过与主账号重复的
        if (accounts.some(a => a.appId === acc.appId)) continue;
        accounts.push(acc);
      }
    }

    // 为每个账号创建客户端
    for (const acc of accounts) {
      const client = new FeishuClient({
        enabled: config.enabled,
        appId: acc.appId,
        appSecret: acc.appSecret,
        verificationToken: acc.verificationToken,
        encryptKey: acc.encryptKey,
        proxy: config.proxy,
      });
      this.clients.push(client);
      logger.info(`Feishu account registered: ${acc.id || acc.appId}`);
    }

    logger.info(`FeishuMultiClient initialized with ${this.clients.length} account(s)`);
  }

  // 设置消息处理回调（所有账号共享）
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
    for (const client of this.clients) {
      client.onMessage(handler);
    }
  }

  // 启动所有连接
  async start(): Promise<void> {
    await Promise.all(this.clients.map(c => c.start()));
    logger.info(`All ${this.clients.length} Feishu connections started`);
  }

  // 回复消息（任一客户端均可回复，使用第一个）
  async replyMessage(messageId: string, content: string): Promise<string> {
    // 飞书回复 API 不区分账号，用第一个客户端即可
    if (this.clients.length === 0) throw new Error('No Feishu client available');
    return this.clients[0].replyMessage(messageId, content);
  }

  // 发送消息（使用第一个客户端）
  async sendMessage(receiveId: string, content: string, receiveIdType?: string): Promise<string> {
    if (this.clients.length === 0) throw new Error('No Feishu client available');
    return this.clients[0].sendMessage(receiveId, content, receiveIdType);
  }

  // 发送图片
  async sendImage(receiveId: string, imagePath: string, receiveIdType?: string): Promise<string> {
    if (this.clients.length === 0) throw new Error('No Feishu client available');
    return this.clients[0].sendImage(receiveId, imagePath, receiveIdType);
  }

  // 发送文件
  async sendFile(receiveId: string, filePath: string, receiveIdType?: string): Promise<string> {
    if (this.clients.length === 0) throw new Error('No Feishu client available');
    return this.clients[0].sendFile(receiveId, filePath, receiveIdType);
  }

  // 发送卡片
  async sendCard(receiveId: string, cardContent: object, receiveIdType: string = 'open_id'): Promise<string> {
    if (this.clients.length === 0) throw new Error('No Feishu client available');
    return this.clients[0].sendCard(receiveId, cardContent, receiveIdType);
  }

  // 获取所有客户端
  getClients(): FeishuClient[] {
    return this.clients;
  }

  // 关闭所有连接
  close(): void {
    for (const client of this.clients) {
      client.close();
    }
  }
}
