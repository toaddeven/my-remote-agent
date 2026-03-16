// @ts-nocheck
// Work Agent 主入口
import { Config } from './types/index.js';
import { SessionManager } from './session/SessionManager.js';
import { Memory } from './memory/Memory.js';
import { CronScheduler } from './cron/CronScheduler.js';
import { Heartbeat } from './heartbeat/Heartbeat.js';
import { LLMClient, ChatOptions } from './llm/LLMClient.js';
import { FeishuClient, FeishuMultiClient, FeishuMessage } from './feishu/FeishuClient.js';
import { Autostart } from './autostart/Autostart.js';
import { SubAgentManager } from './subagent/index.js';
import { Sandbox, createDefaultSandboxConfig } from './sandbox/index.js';
import { TaskQueue, createDefaultQueueOptions, Priority } from './queue/index.js';
import { ConversationLogger } from './memory/ConversationLogger.js';
import { GroupContextBuilder } from './memory/GroupContextBuilder.js';
import { QMDStore } from './memory/QMDStore.js';
import { SlashCommandRouter } from './commands/index.js';
import { logger, readJsonFile } from './utils/index.js';

// 导出优先级常量供外部使用
export { Priority };

export class WorkAgent {
  private config: Config;
  private sessionManager: SessionManager;
  private memory: Memory;
  private cronScheduler: CronScheduler;
  private heartbeat: Heartbeat;
  private llmClient: LLMClient;
  private feishuClient: FeishuMultiClient;
  private autostart: Autostart;
  
  // 新增模块
  private subAgentManager: SubAgentManager;
  private sandbox: Sandbox;
  private taskQueue: TaskQueue;
  private conversationLogger?: ConversationLogger;
  private groupContextBuilder?: GroupContextBuilder;
  private qmdStore?: QMDStore;
  private commandRouter?: SlashCommandRouter;

  private initialized: boolean = false;

  constructor(config: Config) {
    this.config = config;

    // 初始化各模块
    this.sessionManager = new SessionManager(
      config.session.storagePath,
      config.session.maxHistory,
      config.session.ttl
    );

    this.memory = new Memory(
      config.memory.storagePath,
      config.memory.shortTermLimit,
      config.memory.longTermThreshold
    );

    this.cronScheduler = new CronScheduler();
    this.heartbeat = new Heartbeat(config.heartbeat);
    this.llmClient = new LLMClient(config.llm);
    this.feishuClient = new FeishuMultiClient(config.feishu);
    this.autostart = new Autostart(config.autostart || { enabled: false, platform: 'auto' });

    // 初始化子 Agent 管理器
    this.subAgentManager = new SubAgentManager(
      {
        name: 'default',
        maxTokens: config.llm.maxTokens || 4096,
        temperature: config.llm.temperature || 0.7,
        timeout: 5 * 60 * 1000,
      },
      config.subAgent?.maxConcurrent || 5
    );

    // 初始化沙箱
    const sandboxConfig = createDefaultSandboxConfig();
    sandboxConfig.timeout = config.sandbox?.timeout || 30000;
    this.sandbox = new Sandbox(sandboxConfig);

    // 初始化任务队列
    const queueOptions = createDefaultQueueOptions();
    queueOptions.maxConcurrent = config.queue?.maxConcurrent || 3;
    queueOptions.maxQueueSize = config.queue?.maxQueueSize || 0;
    this.taskQueue = new TaskQueue(queueOptions);

    // 初始化 QMD 语义检索
    if (config.qmd?.enabled) {
      this.qmdStore = new QMDStore(config.qmd);
    }

    // 初始化会话上下文构建器（群聊 + 私聊）
    if (config.groupContext?.enabled) {
      this.groupContextBuilder = new GroupContextBuilder(
        this.memory,
        this.llmClient,
        config.groupContext,
        this.qmdStore,
      );
    }

    // 初始化会话日志（飞书对话持久化）
    if (config.memorySync?.enabled) {
      this.conversationLogger = new ConversationLogger(
        this.memory,
        config.memorySync.dailyLogDir || `${process.env.HOME}/.openclaw/workspace/_daily`,
        this.llmClient,
        config.memorySync.useLLMSummary || false,
      );
    }

    // 初始化斜杠命令路由器（仅 claude-cli 模式）
    if (config.llm.provider === 'claude-cli') {
      this.commandRouter = new SlashCommandRouter();
    }
  }

  // 初始化
  async init(): Promise<void> {
    if (this.initialized) return;

    logger.info('Initializing Work Agent...');

    // 初始化内存
    await this.memory.init();
    logger.info(`[冷启动] Memory 已加载 ${this.memory.getLongTermCount()} 条长期记忆`);

    // 初始化 QMD
    if (this.qmdStore) {
      await this.qmdStore.init();
      logger.info('[冷启动] QMD 索引已就绪');
    }

    // 启动定时任务
    if (this.config.cron.enabled) {
      for (const job of this.config.cron.jobs) {
        this.cronScheduler.addJob(job.name, job.schedule, job.handler, job.enabled);
      }
      this.cronScheduler.start();
    }

    // 启动心跳
    if (this.config.heartbeat.enabled) {
      this.heartbeat.start();
    }

    // 启动飞书长连接
    if (this.config.feishu?.appId) {
      this.feishuClient.onMessage((msg) => this.handleFeishuMessage(msg));
      await this.feishuClient.start();
    }

    this.initialized = true;
    logger.info('Work Agent initialized successfully');
  }

  // 处理飞书消息
  async handleFeishuMessage(message: FeishuMessage): Promise<string | null> {
    logger.info(`Received message from ${message.chatId}: ${message.content.substring(0, 50)}...`);

    // claude-cli 模式：直接透传，跳过 session/memory/systemPrompt
    if (this.config.llm.provider === 'claude-cli') {
      return this.handleFeishuMessageCLI(message);
    }

    // 获取或创建会话
    let session = await this.sessionManager.getByChannel(message.chatId);
    if (!session) {
      session = await this.sessionManager.create(message.chatId);
    }

    // 添加用户消息
    await this.sessionManager.addMessage(session.id, 'user', message.content);

    // 添加到短期记忆
    this.memory.addShortTerm(message.content, ['feishu', 'message'], session.id);

    // 构建对话上下文
    const history = this.sessionManager.getHistory(session.id, 10);
    const recentMemory = this.memory.getRecentShortTerm(5);

    // 构建系统提示
    const systemPrompt = this.buildSystemPrompt(recentMemory);

    // 调用 LLM
    const options: ChatOptions = {
      messages: history,
      systemPrompt,
      channelId: message.chatId,
    };

    let response: string;
    try {
      const llmResponse = await this.llmClient.chat(options);
      response = llmResponse.content;
    } catch (error) {
      logger.error('LLM request failed', error);
      response = '抱歉，我暂时无法处理你的请求。';
    }

    // 添加助手消息
    await this.sessionManager.addMessage(session.id, 'assistant', response);

    // 添加到短期记忆
    this.memory.addShortTerm(response, ['feishu', 'response'], session.id);

    // 回复消息
    await this.feishuClient.replyMessage(message.messageId, response);

    return response;
  }

  // claude-cli 透传模式：飞书消息直接给 Claude，中间过程和结果都发到飞书
  private async handleFeishuMessageCLI(message: FeishuMessage): Promise<string | null> {
    const chatId = message.chatId;

    // 立即回复确认收到
    await this.feishuClient.replyMessage(message.messageId, '⏳ 收到，思考中...').catch(err => {
      logger.error('发送确认消息失败', err);
    });

    // 斜杠命令拦截
    if (this.commandRouter) {
      const parsed = this.commandRouter.parse(message.content);
      if (parsed) {
        const result = await this.commandRouter.execute(parsed, chatId);
        if (result.handled) {
          // 内置命令：/new 时同步清除 ClaudeCLIServer 的 session
          if (parsed.command === 'new' || parsed.command === 'clear') {
            this.llmClient.getClaudeCLIServer()?.clearSession(chatId);
          }
          if (result.response) {
            await this.feishuClient.replyMessage(message.messageId, result.response);
          }
          return result.response || null;
        }
        // 非内置命令（如 /commit）：原始消息透传给 Claude CLI
      }
    }

    // 构建发给 Claude 的消息（包含文件路径）
    let claudeMessage = message.content;
    if (message.attachments && message.attachments.length > 0) {
      const fileDescriptions = message.attachments
        .filter(a => a.localPath)
        .map(a => {
          const typeLabel = { image: '图片', file: '文件', video: '视频', audio: '音频' }[a.type] || '文件';
          return `[${typeLabel}] ${a.name || ''} → ${a.localPath}`;
        });

      if (fileDescriptions.length > 0) {
        // 纯图片消息：明确提示 Claude 读取并分析图片
        const isImageOnly = message.messageType === 'image'
          && (!message.content || message.content === '[图片]');
        const defaultPrompt = isImageOnly
          ? '用户发送了一张图片，请读取该图片文件并详细分析图片内容。'
          : '用户发送了以下文件，请分析：';
        claudeMessage = isImageOnly
          ? `${defaultPrompt}\n\n附件:\n${fileDescriptions.join('\n')}`
          : `${claudeMessage || defaultPrompt}\n\n附件:\n${fileDescriptions.join('\n')}`;
      }
    }

    if (!claudeMessage.trim()) {
      claudeMessage = '(空消息)';
    }

    // 中间事件回调：工具调用和结果实时发到飞书
    const onEvent = async (event: any) => {
      try {
        let text = '';
        switch (event.type) {
          case 'tool_call':
            text = `🔧 ${event.toolName}`;
            if (event.toolInput) {
              const input = event.toolInput;
              if (input.command) text += `\n$ ${input.command}`;
              else if (input.file_path) text += `\n📄 ${input.file_path}`;
              else if (input.pattern) text += `\n🔍 ${input.pattern}`;
              else if (input.description) text += `\n${input.description}`;
            }
            break;
          case 'tool_result':
            if (event.toolOutput) {
              text = `📋 ${event.toolName || '结果'}:\n${event.toolOutput}`;
            }
            break;
          default:
            return;
        }
        if (text) {
          await this.feishuClient.sendMessage(chatId, text);
        }
      } catch (err) {
        logger.error('发送中间事件到飞书失败', err);
      }
    };

    // 存储用户消息到长期记忆
    const userTs = Date.now();
    if (this.conversationLogger) {
      await this.memory.storeLongTerm(`conv:${chatId}:${userTs}:user`, {
        content: claudeMessage,
        attachments: message.attachments?.map(a => a.name).join(', ') || undefined,
        channelId: chatId,
      });
      logger.info(`[持久化] conv 消息已存储 (channel=${chatId}, role=user, key=conv:${chatId}:${userTs}:user)`);
    }

    // 异步索引到 QMD（fire-and-forget）
    if (this.qmdStore) {
      this.qmdStore.indexMessage({ channelId: chatId, content: claudeMessage, role: 'user', timestamp: userTs })
        .catch(err => logger.error('QMD 索引失败', err));
    }

    // 构建会话上下文（群聊 + 私聊均注入历史消息）
    let contextPrefix = '';
    if (this.groupContextBuilder) {
      try {
        contextPrefix = await this.groupContextBuilder.buildContext(chatId, claudeMessage);
      } catch (err) {
        logger.error('构建会话上下文失败', err);
      }
    }

    if (contextPrefix) {
      logger.info(`[上下文注入] chatType=${message.chatType}, channel=${chatId}, 注入长度=${contextPrefix.length}字符`);
    } else {
      logger.debug(`[上下文注入] chatType=${message.chatType}, channel=${chatId}, 无历史上下文`);
    }

    const finalMessage = contextPrefix ? `${contextPrefix}${claudeMessage}` : claudeMessage;

    // 读取 per-channel 状态（model/cwd/mode）
    const channelState = this.commandRouter?.getChannelState(chatId);

    let response: string;
    try {
      const llmResponse = await this.llmClient.chat({
        messages: [{ id: '', role: 'user', content: finalMessage, timestamp: Date.now() }],
        channelId: chatId,
        onEvent,
        sendOptions: channelState ? {
          model: channelState.model,
          cwd: channelState.cwd,
          permissionMode: channelState.permissionMode,
        } : undefined,
      });
      response = llmResponse.content;

      // 同步 sessionId 回 commandRouter
      const cliServer = this.llmClient.getClaudeCLIServer();
      if (cliServer && this.commandRouter) {
        const sessions = cliServer.getStats().sessions;
        const current = sessions.find(s => s.channelId === chatId);
        if (current) {
          this.commandRouter.setSessionId(chatId, current.sessionId);
        }
      }

      logger.info(`Claude CLI 响应 (channel=${chatId}, len=${response.length})`);
    } catch (error) {
      logger.error('Claude CLI 请求失败', error);
      response = '抱歉，Claude 暂时无法处理你的请求。';
    }

    // 存储助手回复到长期记忆
    const assistantTs = Date.now();
    if (this.conversationLogger) {
      await this.memory.storeLongTerm(`conv:${chatId}:${assistantTs}:assistant`, {
        content: response,
        channelId: chatId,
      });
      logger.info(`[持久化] conv 消息已存储 (channel=${chatId}, role=assistant)`);
    }

    // 异步索引助手回复到 QMD
    if (this.qmdStore) {
      this.qmdStore.indexMessage({ channelId: chatId, content: response, role: 'assistant', timestamp: assistantTs })
        .catch(err => logger.error('QMD 索引失败', err));
    }

    // 最终回复
    await this.feishuClient.replyMessage(message.messageId, response);
    return response;
  }

  // 构建系统提示
  private buildSystemPrompt(recentMemory: Array<{ content: string; timestamp: number }>): string {
    const memoryContext = recentMemory.length > 0
      ? `\n\n最近的对话上下文:\n${recentMemory.map(m => `- ${m.content}`).join('\n')}`
      : '';

    return `你是 Work Agent，一个独立的 AI 助手。${memoryContext}`;
  }

  // 发送消息到指定会话
  async sendMessage(channel: string, content: string): Promise<string> {
    return this.feishuClient.sendMessage(channel, content);
  }

  // 注册 Cron 处理器
  registerCronHandler(name: string, handler: () => Promise<void> | void): void {
    this.cronScheduler.registerHandler(name, handler);
  }

  // 注册 Heartbeat 处理器
  registerHeartbeatHandler(name: string, handler: () => Promise<void> | void): void {
    this.heartbeat.registerHandler(name, handler);
  }

  // 获取会话管理器
  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  // 获取内存
  getMemory(): Memory {
    return this.memory;
  }

  // 获取 LLM 客户端
  getLLMClient(): LLMClient {
    return this.llmClient;
  }

  // 获取飞书客户端（多账号）
  getFeishuClient(): FeishuMultiClient {
    return this.feishuClient;
  }

  // 获取 Autostart 实例
  getAutostart(): Autostart {
    return this.autostart;
  }

  // 获取子 Agent 管理器
  getSubAgentManager(): SubAgentManager {
    return this.subAgentManager;
  }

  // 获取沙箱
  getSandbox(): Sandbox {
    return this.sandbox;
  }

  // 获取任务队列
  getTaskQueue(): TaskQueue {
    return this.taskQueue;
  }

  // 获取会话日志器
  getConversationLogger(): ConversationLogger | undefined {
    return this.conversationLogger;
  }

  // 获取状态
  getStatus(): object {
    const queueStats = this.taskQueue.getStats();
    const sandboxStats = this.sandbox.getStats();
    const sessions = this.sessionManager.getAll?.() || [];
    
    return {
      initialized: this.initialized,
      sessionCount: sessions.length,
      heartbeatRunning: this.heartbeat.isRunning(),
      cronJobs: this.cronScheduler.getJobs().length,
      autostart: this.autostart.getStatus(),
      subAgent: {
        running: this.subAgentManager.getRunningCount(),
        maxConcurrent: this.subAgentManager.getMaxConcurrent(),
        totalAgents: this.subAgentManager.getAll().length,
      },
      sandbox: {
        activeContexts: sandboxStats.activeContexts,
        totalExecutions: sandboxStats.totalExecutions,
        successRate: sandboxStats.totalExecutions > 0 
          ? (sandboxStats.successfulExecutions / sandboxStats.totalExecutions * 100).toFixed(1) + '%'
          : 'N/A',
      },
      queue: {
        pending: queueStats.pending,
        running: queueStats.running,
        completed: queueStats.completed,
        failed: queueStats.failed,
      },
    };
  }

  // 停止
  async stop(): Promise<void> {
    logger.info('Stopping Work Agent...');

    this.feishuClient.close();
    this.heartbeat.stop();
    this.cronScheduler.stop();

    // 清理 LLM 客户端资源（claude-cli 进程池等）
    this.llmClient.destroy();

    // 关闭 QMD
    if (this.qmdStore) {
      await this.qmdStore.close();
    }

    // 清理新模块
    this.taskQueue.destroy();
    this.subAgentManager.cleanup();
    this.sandbox.cleanup();
    
    logger.info('Work Agent stopped');
  }
}

// 默认配置
export function createDefaultConfig(): Config {
  return {
    name: 'work-agent',
    version: '1.0.0',
    dataDir: process.env.HOME + '/.work-agent' || '/root/.work-agent',
    workspace: process.env.HOME + '/.work-agent/workspace' || '/root/.work-agent/workspace',
    memoryDb: process.env.HOME + '/.work-agent/memory.sqlite' || '/root/.work-agent/memory.sqlite',
    session: {
      storagePath: './data/sessions',
      maxHistory: 100,
      ttl: 24 * 60 * 60 * 1000,
      compactionThreshold: 50,
    },
    memory: {
      storagePath: './data/memory',
      shortTermLimit: 50,
      longTermThreshold: 30 * 60 * 1000,
    },
    cron: {
      enabled: false,
      jobs: [],
    },
    heartbeat: {
      enabled: false,
      intervalMs: 30 * 60 * 1000,
      handlers: [],
    },
    llm: {
      provider: 'minimax',
      apiKey: '',
      model: 'abab6.5s-chat',
      maxTokens: 8192,
    },
    feishu: {
      enabled: false,
      appId: '',
      appSecret: '',
    },
    autostart: {
      enabled: false,
      platform: 'auto',
    },
    subAgent: {
      enabled: true,
      maxConcurrent: 5,
      defaultTimeout: 5 * 60 * 1000,
    },
    sandbox: {
      enabled: true,
      timeout: 30000,
    },
    queue: {
      maxConcurrent: 3,
      maxQueueSize: 0,
      defaultTimeout: 60000,
    },
    groupContext: {
      enabled: false,
      recentWindowMinutes: 30,
      recentMaxMessages: 20,
      searchOlderMessages: true,
      searchTopK: 5,
      compressOlderMessages: false,
      compressThresholdMessages: 50,
    },
    memorySync: {
      enabled: false,
      dailyLogDir: (process.env.HOME || '/root') + '/.openclaw/workspace/_daily',
      cronSchedule: '0 23 * * *',
      useLLMSummary: false,
    },
    qmd: {
      enabled: false,
      dbPath: './data/qmd',
      collectionName: 'work-agent-conv',
      minScore: 0.25,
    },
  };
}

// 从文件加载配置
export async function loadConfig(configPath: string): Promise<Config> {
  const defaultConfig = createDefaultConfig();
  const fileConfig = await readJsonFile<Partial<Config>>(configPath);
  
  if (!fileConfig) {
    return defaultConfig;
  }

  return { ...defaultConfig, ...fileConfig } as Config;
}

export default WorkAgent;
