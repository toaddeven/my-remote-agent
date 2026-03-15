// @ts-nocheck
// LLM 客户端 - Claude/OpenAI/MiniMax/Claude-CLI
import { LLMConfig, Message } from '../types/index.js';
import { logger } from '../utils/index.js';
import { ClaudeCLIServer, CLIEventCallback } from './ClaudeCLIServer.js';

export interface LLMResponse {
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason?: string;
}

export interface ChatOptions {
  messages: Message[];
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  channelId?: string;  // 用于 claude-cli provider 的会话管理
  onEvent?: CLIEventCallback; // claude-cli 中间事件回调
}

export class LLMClient {
  private config: LLMConfig;
  private claudeCLIServer?: ClaudeCLIServer;

  constructor(config: LLMConfig) {
    this.config = config;

    if (config.provider === 'claude-cli') {
      this.claudeCLIServer = new ClaudeCLIServer({
        cliPath: config.cliPath,
        cliFlags: config.cliFlags,
        responseTimeout: config.cliTimeout,
      });
    }

    logger.info(`LLM client initialized with provider: ${config.provider}`);
  }

  // 聊天接口
  async chat(options: ChatOptions): Promise<LLMResponse> {
    switch (this.config.provider) {
      case 'claude':
        return this.chatClaude(options);
      case 'openai':
        return this.chatOpenAI(options);
      case 'minimax':
        return this.chatMiniMax(options);
      case 'claude-cli':
        return this.chatClaudeCLI(options);
      default:
        throw new Error(`Unsupported provider: ${this.config.provider}`);
    }
  }

  // Claude API
  private async chatClaude(options: ChatOptions): Promise<LLMResponse> {
    const url = `${this.config.baseUrl || 'https://api.anthropic.com'}/v1/messages`;
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.config.apiKey,
      'anthropic-version': '2023-06-01',
    };

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: options.messages.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : m.role,
        content: m.content,
      })),
      max_tokens: options.maxTokens || this.config.maxTokens || 4096,
      temperature: options.temperature || this.config.temperature || 0.7,
    };

    if (options.systemPrompt) {
      body.system = options.systemPrompt;
    }

    const response = await this.request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const data = await response.json() as Record<string, unknown>;
    
    if (!response.ok) {
      throw new Error(`Claude API error: ${JSON.stringify(data)}`);
    }

    const content = (data.content as Array<{ type: string; text: string }>)
      ?.find(c => c.type === 'text')?.text || '';

    const usageData = data.usage as Record<string, number> | undefined;

    return {
      content,
      model: this.config.model,
      usage: {
        promptTokens: usageData?.input_tokens || 0,
        completionTokens: usageData?.output_tokens || 0,
        totalTokens: (usageData?.input_tokens || 0) + (usageData?.output_tokens || 0),
      },
      finishReason: data.stop_reason as string,
    };
  }

  // OpenAI API
  private async chatOpenAI(options: ChatOptions): Promise<LLMResponse> {
    const url = `${this.config.baseUrl || 'https://api.openai.com'}/v1/chat/completions`;
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.apiKey}`,
    };

    const messages: Array<{ role: string; content: string }> = [];
    
    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    
    messages.push(...options.messages.map(m => ({
      role: m.role,
      content: m.content,
    })));

    const body = {
      model: this.config.model,
      messages,
      max_tokens: options.maxTokens || this.config.maxTokens || 4096,
      temperature: options.temperature || this.config.temperature || 0.7,
    };

    const response = await this.request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const data = await response.json() as Record<string, unknown>;
    
    if (!response.ok) {
      throw new Error(`OpenAI API error: ${JSON.stringify(data)}`);
    }

    const choice = (data.choices as Array<{ message: { content: string }; finish_reason: string }>)?.[0];
    
    return {
      content: choice?.message?.content || '',
      model: this.config.model,
      usage: {
        promptTokens: (data.usage as any)?.prompt_tokens as number || 0,
        completionTokens: (data.usage as any)?.completion_tokens as number || 0,
        totalTokens: (data.usage as any)?.total_tokens as number || 0,
      },
      finishReason: choice?.finish_reason,
    };
  }

  // MiniMax API
  private async chatMiniMax(options: ChatOptions): Promise<LLMResponse> {
    const baseUrl = (this.config.baseUrl || 'https://api.minimax.chat/v1').replace(/\/+$/, '');
    const url = `${baseUrl}/text/chatcompletion_pro`;
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.apiKey}`,
    };

    const messages: Array<{ role: string; content: string }> = [];
    
    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    
    messages.push(...options.messages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : m.role,
      content: m.content,
    })));

    const body = {
      model: this.config.model,
      messages,
      max_tokens: options.maxTokens || this.config.maxTokens || 4096,
      temperature: options.temperature || this.config.temperature || 0.7,
    };

    const response = await this.request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const data = await response.json() as Record<string, unknown>;
    
    if (!response.ok) {
      throw new Error(`MiniMax API error: ${JSON.stringify(data)}`);
    }

    const choice = (data.choices as Array<{ message: { content: string }; finish_reason: string }>)?.[0];
    
    return {
      content: choice?.message?.content || '',
      model: this.config.model,
      usage: {
        promptTokens: (data.usage as any)?.prompt_tokens as number || 0,
        completionTokens: (data.usage as any)?.completion_tokens as number || 0,
        totalTokens: (data.usage as any)?.total_tokens as number || 0,
      },
      finishReason: choice?.finish_reason,
    };
  }

  // HTTP 请求
  private async request(url: string, options: RequestInit): Promise<Response> {
    const response = await fetch(url, options);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await response.text();
      throw new Error(
        `LLM API returned non-JSON response (status=${response.status}, content-type=${contentType}): ${text.substring(0, 200)}`
      );
    }
    return response;
  }

  // Claude CLI（持久进程）
  private async chatClaudeCLI(options: ChatOptions): Promise<LLMResponse> {
    if (!this.claudeCLIServer) {
      throw new Error('ClaudeCLIServer 未初始化');
    }

    // CLI 进程自己维护对话历史，只发送最后一条 user 消息
    const lastUserMsg = [...options.messages].reverse().find(m => m.role === 'user');
    const message = lastUserMsg?.content || '';

    if (!message) {
      throw new Error('没有找到用户消息');
    }

    const channelId = options.channelId || 'default';
    const result = await this.claudeCLIServer.sendMessage(channelId, message, options.onEvent);

    return {
      content: result.content,
      model: this.config.model || 'claude-cli',
      usage: result.usage ? {
        promptTokens: result.usage.inputTokens,
        completionTokens: result.usage.outputTokens,
        totalTokens: result.usage.inputTokens + result.usage.outputTokens,
      } : undefined,
      finishReason: 'end_turn',
    };
  }

  // 更新配置
  updateConfig(config: Partial<LLMConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // 获取当前配置
  getConfig(): LLMConfig {
    return { ...this.config };
  }

  // 销毁资源（claude-cli 进程池等）
  destroy(): void {
    this.claudeCLIServer?.destroy();
  }
}
