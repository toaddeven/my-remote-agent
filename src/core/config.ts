import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('config');

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  domain: 'feishu' | 'lark';
  botName: string;
}

export interface ModelConfig {
  backend: 'api' | 'cli';
  default: string;
  apiKey?: string;
  baseUrl?: string;
  cli?: {
    path: string;
    timeout: number;
  };
}

export interface AgentConfig {
  id: string;
  model?: string;
  workspace?: string;
  systemPrompt?: string;
}

export interface BindingConfig {
  agentId: string;
  match: {
    channel: string;
    peer?: {
      kind: 'direct' | 'group';
      id?: string;
    };
  };
}

export interface SessionConfig {
  dmScope: 'per-peer' | 'global';
  reset?: {
    kind: 'daily' | 'manual' | 'never';
    time?: string;
  };
  maxContextMessages?: number;
}

export interface MessagesConfig {
  queue?: {
    mode: 'followup' | 'steer' | 'interrupt';
    debounceMs?: number;
  };
}

export interface AcpConfig {
  enabled: boolean;
  defaultAgent?: string;
  allowedAgents?: string[];
  maxConcurrentSessions?: number;
  allowedPaths?: string[];
}

export interface AppConfig {
  feishu: FeishuConfig;
  model: ModelConfig;
  agents: AgentConfig[];
  bindings: BindingConfig[];
  session?: SessionConfig;
  messages?: MessagesConfig;
  acp?: AcpConfig;
}

export function resolveEnvVars(str: string): string {
  return str.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    const value = process.env[varName];
    if (value === undefined) {
      logger.warn(`Environment variable ${varName} is not set`);
      return '';
    }
    return value;
  });
}

function resolveEnvVarsDeep(value: unknown): unknown {
  if (typeof value === 'string') {
    return resolveEnvVars(value);
  }
  if (Array.isArray(value)) {
    return value.map(resolveEnvVarsDeep);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = resolveEnvVarsDeep(v);
    }
    return result;
  }
  return value;
}

export function loadConfig(configPath?: string): AppConfig {
  const filePath = configPath ?? process.env['CONFIG_PATH'] ?? resolve(process.cwd(), 'config.json');

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to read config file at ${filePath}: ${String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse config file at ${filePath}: ${String(err)}`);
  }

  const resolved = resolveEnvVarsDeep(parsed) as AppConfig;

  // Basic validation
  if (!resolved.feishu) throw new Error('Config missing required field: feishu');
  if (!resolved.feishu.appId) throw new Error('Config missing required field: feishu.appId');
  if (!resolved.feishu.appSecret) throw new Error('Config missing required field: feishu.appSecret');
  if (!resolved.model) throw new Error('Config missing required field: model');
  if (!resolved.agents || resolved.agents.length === 0) throw new Error('Config must have at least one agent');
  if (!resolved.bindings || resolved.bindings.length === 0) throw new Error('Config must have at least one binding');

  logger.info(`Config loaded from ${filePath}`);
  return resolved;
}
