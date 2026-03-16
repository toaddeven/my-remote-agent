// Work Agent 类型定义

export interface Session {
  id: string;
  channel: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  context: Record<string, unknown>;
  status: 'active' | 'paused' | 'closed';
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryEntry {
  id: string;
  content: string;
  timestamp: number;
  type: 'short_term' | 'long_term' | 'working';
  tags?: string[];
  sessionId?: string;
  // 向量相关字段
  vector?: number[];
}

// 向量检索结果
export interface SearchResult {
  id: string;
  content: string;
  timestamp: number;
  type: 'short_term' | 'long_term' | 'working';
  tags?: string[];
  sessionId?: string;
  score: number; // 相似度分数
}

// Embedding 配置
export interface EmbeddingConfig {
  provider: 'openai' | 'ollama' | 'local';
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface CronJob {
  id: string;
  name: string;
  schedule: string; // cron expression
  handler: string; // handler name
  enabled: boolean;
  lastRun?: number;
  nextRun?: number;
}

export interface HeartbeatConfig {
  enabled: boolean;
  intervalMs: number;
  handlers: string[];
  prompt?: string;
}

export interface LLMConfig {
  provider: 'anthropic' | 'openai' | 'ollama' | 'claude' | 'minimax' | 'claude-cli';
  apiKey: string;
  baseUrl?: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  thinking?: boolean;
  proxy?: string;
  // claude-cli 特有配置
  cliPath?: string;        // CLI 路径，默认 'claude'
  cliTimeout?: number;     // 单次响应超时，默认 120000ms
  cliFlags?: string[];     // 额外 CLI 参数
}

export interface FeishuConfig {
  proxy?: string;
  enabled: boolean;
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
}

export interface Config {
  // General
  name: string;
  version: string;
  
  // Paths
  dataDir: string;
  workspace: string;
  memoryDb: string;
  
  // Session
  session: {
    storagePath: string;
    maxHistory: number;
    ttl: number;
    compactionThreshold: number;
  };
  
  // Memory
  memory: {
    storagePath: string;
    shortTermLimit: number;
    longTermThreshold: number;
  };
  
  // Cron
  cron: {
    enabled: boolean;
    jobs: CronJob[];
    jobsFile?: string;
  };
  
  // Heartbeat
  heartbeat: HeartbeatConfig;
  
  // LLM
  llm: LLMConfig;
  
  // Feishu
  feishu: FeishuConfig;
  
  // Proxy
  proxy?: {
    enabled: boolean;
    url: string;
  };
  
  // Auto-start
  autostart?: {
    enabled: boolean;
    platform: 'darwin' | 'linux' | 'auto';
  };
  
  // Sub-agent
  subAgent?: {
    enabled: boolean;
    maxConcurrent: number;
    defaultTimeout?: number;
    defaultTools?: string[];
  };
  
  // Sandbox
  sandbox?: {
    enabled: boolean;
    timeout: number;
    maxMemory?: number;
    networkEnabled?: boolean;
    allowedModules?: string[];
  };
  
  // Queue
  queue?: {
    maxConcurrent: number;
    maxQueueSize?: number;
    defaultTimeout?: number;
    defaultPriority?: number;
  };

  // Group context — 群聊上下文注入
  groupContext?: {
    enabled: boolean;
    recentWindowMinutes: number;    // 近期窗口（分钟），默认 30
    recentMaxMessages: number;      // 近期最多条数，默认 20
    searchOlderMessages: boolean;   // 是否检索更早消息
    searchTopK: number;             // 检索返回条数，默认 5
    compressOlderMessages: boolean; // 是否用 LLM 压缩远期消息
    compressThresholdMessages: number; // 超过 N 条触发压缩，默认 50
  };

  // Memory sync — 飞书会话持久化 + 每日摘要
  memorySync?: {
    enabled: boolean;
    dailyLogDir: string;      // 默认 ~/.openclaw/workspace/_daily/
    cronSchedule: string;     // 默认 "0 23 * * *"
    useLLMSummary: boolean;   // 是否用 LLM 生成摘要（否则直接存原文）
  };

  // QMD — 混合检索（BM25 + 向量 + LLM 重排序）
  qmd?: {
    enabled: boolean;
    dbPath?: string;           // QMD 数据目录，默认 ./data/qmd
    collectionName?: string;   // collection 名，默认 'work-agent-conv'
    minScore?: number;         // 检索最低分，默认 0.25
  };
}
