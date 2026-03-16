// @ts-nocheck
// Claude CLI Server — spawn claude --print --output-format stream-json --verbose
// 支持工具调用过程和流式中间输出的实时回调
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { logger } from '../utils/index.js';

// CLI 响应结果
export interface CLIResult {
  content: string;
  sessionId: string;
  usage?: { inputTokens: number; outputTokens: number };
  costUsd?: number;
  durationMs?: number;
}

// 中间事件（工具调用、工具结果等）
export interface CLIEvent {
  type: 'init' | 'tool_call' | 'tool_result' | 'text_delta' | 'result';
  // init
  model?: string;
  version?: string;
  sessionId?: string;
  // tool_call
  toolName?: string;
  toolInput?: any;
  // tool_result
  toolOutput?: string;
  // text_delta
  text?: string;
  // result
  content?: string;
  costUsd?: number;
}

// 事件回调
export type CLIEventCallback = (event: CLIEvent) => void;

// 每次调用的可选覆盖参数（由 SlashCommandRouter 管理状态，WorkAgent 透传）
export interface SendOptions {
  model?: string;
  cwd?: string;
  permissionMode?: string;
}

// CLI Server 配置
export interface CLIServerConfig {
  cliPath?: string;
  cliFlags?: string[];
  responseTimeout?: number;
}

// Claude 进程异常
export class ClaudeCLIError extends Error {
  constructor(
    message: string,
    public readonly exitCode?: number,
    public readonly stderr?: string,
  ) {
    super(message);
    this.name = 'ClaudeCLIError';
  }
}

// Claude CLI Server — 管理 channelId → sessionId 映射
export class ClaudeCLIServer {
  private sessionMap: Map<string, string> = new Map();
  private cliPath: string;
  private cliFlags: string[];
  private responseTimeout: number;
  private persistPath?: string;

  constructor(config: CLIServerConfig & { persistPath?: string } = {}) {
    this.cliPath = config.cliPath || 'claude';
    this.cliFlags = config.cliFlags || [];
    this.responseTimeout = config.responseTimeout || 120000;
    this.persistPath = config.persistPath;

    // 同步加载已有 session 映射
    if (this.persistPath) {
      this.loadSessionMapSync();
    }

    logger.info(`ClaudeCLIServer 启动 (path=${this.cliPath}, timeout=${this.responseTimeout}ms, restored=${this.sessionMap.size} sessions)`);
  }

  // 发送消息，支持中间事件回调和每次调用的覆盖参数
  async sendMessage(channelId: string, message: string, onEvent?: CLIEventCallback, options?: SendOptions): Promise<CLIResult> {
    const sessionId = this.sessionMap.get(channelId);

    try {
      const result = await this.spawnAndSend(message, sessionId, onEvent, options);
      if (result.sessionId) {
        this.sessionMap.set(channelId, result.sessionId);
        this.saveSessionMap().catch(() => {});
      }
      return result;
    } catch (err) {
      // --resume 失败，清除 session 重试
      if (sessionId && err instanceof ClaudeCLIError) {
        logger.warn(`Claude CLI --resume 失败，清除 session 重试 (channel=${channelId})`);
        this.sessionMap.delete(channelId);
        const result = await this.spawnAndSend(message, undefined, onEvent, options);
        if (result.sessionId) {
          this.sessionMap.set(channelId, result.sessionId);
          this.saveSessionMap().catch(() => {});
        }
        return result;
      }
      throw err;
    }
  }

  // spawn claude --print --output-format stream-json --verbose
  private spawnAndSend(message: string, sessionId?: string, onEvent?: CLIEventCallback, options?: SendOptions): Promise<CLIResult> {
    return new Promise((resolve, reject) => {
      const args = [
        '--print',
        '--output-format', 'stream-json',
        '--verbose',
        ...this.cliFlags,
      ];

      if (sessionId) {
        args.push('--resume', sessionId);
      }

      // 按需添加覆盖参数
      if (options?.model) {
        args.push('--model', options.model);
      }
      if (options?.permissionMode) {
        args.push('--permission-mode', options.permissionMode);
      }

      logger.info(`spawn claude (session=${sessionId || 'new'}, model=${options?.model || 'default'}, msg=${message.substring(0, 50)}...)`);

      const spawnOpts: any = {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      };
      if (options?.cwd) {
        spawnOpts.cwd = options.cwd;
      }

      const proc = spawn(this.cliPath, args, spawnOpts);

      let stderr = '';
      let killed = false;
      let resultData: CLIResult | null = null;
      // 追踪待处理的工具调用
      const pendingToolCalls: Map<string, { name: string; input: any }> = new Map();

      // 超时处理
      const timer = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
      }, this.responseTimeout);

      proc.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      // 逐行解析 NDJSON
      const rl = createInterface({ input: proc.stdout! });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        let data: any;
        try {
          data = JSON.parse(line);
        } catch {
          return;
        }

        this.handleStreamEvent(data, onEvent, pendingToolCalls);

        // 捕获 result
        if (data.type === 'result') {
          resultData = {
            content: data.result || '',
            sessionId: data.session_id || '',
            usage: data.usage ? {
              inputTokens: data.usage.input_tokens || 0,
              outputTokens: data.usage.output_tokens || 0,
            } : undefined,
            costUsd: data.total_cost_usd,
            durationMs: data.duration_ms,
          };
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        if (err.code === 'ENOENT') {
          reject(new ClaudeCLIError(`Claude CLI 未找到: ${this.cliPath}`));
        } else {
          reject(err);
        }
      });

      proc.on('close', (code) => {
        clearTimeout(timer);

        if (killed) {
          reject(new ClaudeCLIError(`Claude CLI 响应超时 (${this.responseTimeout}ms)`, code ?? undefined, stderr));
          return;
        }

        if (resultData) {
          resolve(resultData);
          return;
        }

        if (code !== 0) {
          reject(new ClaudeCLIError(`Claude CLI 退出码 ${code}: ${stderr.substring(0, 500)}`, code ?? undefined, stderr));
          return;
        }

        // 没有 result 事件但正常退出
        resolve({ content: '', sessionId: sessionId || '', costUsd: 0, durationMs: 0 });
      });

      // 写入消息并关闭 stdin
      proc.stdin!.write(message);
      proc.stdin!.end();
    });
  }

  // 处理 stream-json 事件并触发回调
  private handleStreamEvent(data: any, onEvent?: CLIEventCallback, pendingToolCalls?: Map<string, { name: string; input: any }>) {
    if (!onEvent) return;

    switch (data.type) {
      case 'system':
        if (data.subtype === 'init') {
          onEvent({
            type: 'init',
            model: data.model,
            version: data.claude_code_version,
            sessionId: data.session_id,
          });
        }
        break;

      case 'assistant': {
        // assistant 消息中包含工具调用
        const content = data.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_use') {
              // 记录工具调用，等待结果
              pendingToolCalls?.set(block.id, { name: block.name, input: block.input });
              onEvent({
                type: 'tool_call',
                toolName: block.name,
                toolInput: block.input,
              });
            }
          }
        }
        break;
      }

      case 'user': {
        // user 消息中包含工具结果
        const content = data.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              const toolCall = pendingToolCalls?.get(block.tool_use_id);
              // 优先用 tool_use_result 中的 stdout
              const output = data.tool_use_result?.stdout || (typeof block.content === 'string' ? block.content : '');
              onEvent({
                type: 'tool_result',
                toolName: toolCall?.name,
                toolOutput: output.substring(0, 500), // 截断过长输出
              });
              pendingToolCalls?.delete(block.tool_use_id);
            }
          }
        }
        break;
      }

      case 'result':
        onEvent({
          type: 'result',
          content: data.result,
          costUsd: data.total_cost_usd,
          sessionId: data.session_id,
        });
        break;
    }
  }

  // 保存 session 映射到磁盘
  private async saveSessionMap(): Promise<void> {
    if (!this.persistPath) return;
    try {
      const fs = await import('fs/promises');
      await fs.mkdir(this.persistPath, { recursive: true });
      const filePath = `${this.persistPath}/cli-sessions.json`;
      const data: Record<string, string> = {};
      for (const [k, v] of this.sessionMap.entries()) {
        data[k] = v;
      }
      await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      logger.error('[ClaudeCLI] session 映射保存失败', err);
    }
  }

  // 同步加载 session 映射（构造函数中调用）
  private loadSessionMapSync(): void {
    if (!this.persistPath) return;
    try {
      const fs = require('fs');
      const filePath = `${this.persistPath}/cli-sessions.json`;
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === 'string') {
          this.sessionMap.set(k, v);
        }
      }
    } catch {
      // 文件不存在，忽略
    }
  }

  // 查询是否有活跃 session
  hasSession(channelId: string): boolean {
    return this.sessionMap.has(channelId);
  }

  clearSession(channelId: string) {
    this.sessionMap.delete(channelId);
    this.saveSessionMap().catch(() => {});
  }

  // 设置指定 channel 的 sessionId（用于 /resume 斜杠命令）
  setSession(channelId: string, sessionId: string) {
    this.sessionMap.set(channelId, sessionId);
    this.saveSessionMap().catch(() => {});
  }

  getStats() {
    return {
      activeSessions: this.sessionMap.size,
      sessions: Array.from(this.sessionMap.entries()).map(([channelId, sessionId]) => ({
        channelId,
        sessionId,
      })),
    };
  }

  destroy() {
    this.sessionMap.clear();
    logger.info('ClaudeCLIServer 已销毁');
  }
}
