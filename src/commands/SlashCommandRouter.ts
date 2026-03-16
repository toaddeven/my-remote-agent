// @ts-nocheck
// 斜杠命令路由器 — 解析和处理飞书中的 /command 消息

import { spawn } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { logger } from '../utils/index.js';

// 命令解析结果
export interface ParsedCommand {
  command: string;   // 不含 '/'，小写
  args: string;      // 命令后的参数文本
  raw: string;       // 原始消息
}

// 命令执行结果
export interface CommandResult {
  handled: boolean;      // true = 命令已处理，不发给 Claude
  response?: string;     // 回复给飞书的文本
}

// channel 状态（per-channel model/cwd/mode）
export interface ChannelState {
  sessionId?: string;
  model?: string;
  cwd?: string;
  permissionMode?: string;
  startedAt?: number;
}

// 模型别名映射
const MODEL_ALIASES: Record<string, string> = {
  'opus': 'claude-opus-4-6',
  'sonnet': 'claude-sonnet-4-6',
  'haiku': 'claude-haiku-4-5-20251001',
};

// 权限模式
const VALID_MODES = ['default', 'plan', 'bypassPermissions'];

// 内置命令集合
const BOT_COMMANDS = new Set([
  'help', 'h', 'new', 'clear', 'resume', 'model',
  'mode', 'status', 'cd', 'skills', 'mcp', 'usage',
]);

// 帮助文本
const HELP_TEXT = `📖 **命令帮助**

| 命令 | 说明 |
|------|------|
| /new | 开始新 session |
| /resume | 查看当前 session ID |
| /model opus\\|sonnet\\|haiku | 切换模型 |
| /status | 当前 session 信息 |
| /cd ~/project | 切换工作目录 |
| /usage | 查看 Claude 用量 |
| /skills | 列出 Claude Skills |
| /mcp | 列出 MCP Servers |
| /mode bypass\\|default\\|plan | 切换权限模式 |
| /help | 帮助 |
| /commit 等 | 透传给 Claude CLI Skills |`;

export class SlashCommandRouter {
  // 每个 channel 的状态
  private channelStateMap: Map<string, ChannelState> = new Map();

  constructor() {}

  // 解析消息 — 非命令返回 null
  parse(content: string): ParsedCommand | null {
    const text = (content || '').trim();
    if (!text.startsWith('/')) return null;

    // 用正则分割，限制 2 段
    const parts = text.substring(1).split(/\s+/, 2);
    const command = parts[0]?.toLowerCase();
    if (!command) return null;

    // args 是命令词之后的全部文本
    const args = text.substring(1 + command.length).trim();
    return { command, args, raw: text };
  }

  // 执行已解析的命令
  // 内置命令 → { handled: true, response }
  // 非内置命令 → { handled: false }，由调用方透传给 Claude CLI 作为 skill
  async execute(cmd: ParsedCommand, channelId: string): Promise<CommandResult> {
    if (!BOT_COMMANDS.has(cmd.command)) {
      // 非内置命令 — 透传给 Claude（如 /commit, /review）
      return { handled: false };
    }

    // 分派到对应处理器
    switch (cmd.command) {
      case 'help':
      case 'h':
        return { handled: true, response: HELP_TEXT };

      case 'new':
      case 'clear':
        return this.handleNew(channelId);

      case 'resume':
        return this.handleResume(channelId);

      case 'model':
        return this.handleModel(channelId, cmd.args);

      case 'status':
        return this.handleStatus(channelId);

      case 'cd':
        return this.handleCd(channelId, cmd.args);

      case 'mode':
        return this.handleMode(channelId, cmd.args);

      case 'usage':
        return this.handleUsage();

      case 'skills':
        return this.handleSkills();

      case 'mcp':
        return this.handleMcp();

      default:
        return { handled: true, response: `❌ 未知命令: /${cmd.command}` };
    }
  }

  // --- Channel 状态管理 ---

  getChannelState(channelId: string): ChannelState {
    if (!this.channelStateMap.has(channelId)) {
      this.channelStateMap.set(channelId, {});
    }
    return this.channelStateMap.get(channelId)!;
  }

  // 由 ClaudeCLIServer 在分配 session 时调用
  setSessionId(channelId: string, sessionId: string) {
    const state = this.getChannelState(channelId);
    state.sessionId = sessionId;
    if (!state.startedAt) state.startedAt = Date.now();
  }

  getSessionId(channelId: string): string | undefined {
    return this.channelStateMap.get(channelId)?.sessionId;
  }

  // --- 命令处理器 ---

  private handleNew(channelId: string): CommandResult {
    const state = this.channelStateMap.get(channelId);
    const oldSessionId = state?.sessionId;

    // 只清 session，保留 model/cwd/mode
    if (state) {
      state.sessionId = undefined;
      state.startedAt = undefined;
    }

    const msg = oldSessionId
      ? `✅ 已开始新 session\n上个会话: \`${oldSessionId.substring(0, 8)}...\``
      : '✅ 已开始新 session';
    return { handled: true, response: msg };
  }

  private handleResume(channelId: string): CommandResult {
    const state = this.channelStateMap.get(channelId);
    if (state?.sessionId) {
      return { handled: true, response: `当前 session: \`${state.sessionId}\`` };
    }
    return { handled: true, response: '当前没有活跃的 session' };
  }

  private handleModel(channelId: string, args: string): CommandResult {
    if (!args) {
      const current = this.getChannelState(channelId).model || '默认';
      return { handled: true, response: `当前模型: \`${current}\`\n可选: opus, sonnet, haiku` };
    }

    const model = MODEL_ALIASES[args.toLowerCase()] || args;
    this.getChannelState(channelId).model = model;
    return { handled: true, response: `✅ 已切换模型为 \`${model}\`` };
  }

  private handleStatus(channelId: string): CommandResult {
    const state = this.getChannelState(channelId);
    const lines = [
      `📊 **Session 状态**`,
      `- Session: \`${state.sessionId || '无'}\``,
      `- 模型: \`${state.model || '默认'}\``,
      `- 工作目录: \`${state.cwd || process.cwd()}\``,
      `- 权限模式: \`${state.permissionMode || 'bypassPermissions'}\``,
    ];

    if (state.startedAt) {
      const mins = Math.round((Date.now() - state.startedAt) / 60000);
      lines.push(`- 已运行: ${mins} 分钟`);
    }

    return { handled: true, response: lines.join('\n') };
  }

  private handleCd(channelId: string, args: string): CommandResult {
    if (!args) {
      const cwd = this.getChannelState(channelId).cwd || process.cwd();
      return { handled: true, response: `当前工作目录: \`${cwd}\`` };
    }

    // 展开 ~ 为 HOME
    const resolved = args.startsWith('~')
      ? path.join(process.env.HOME || '/root', args.substring(1))
      : path.resolve(args);

    if (!existsSync(resolved)) {
      return { handled: true, response: `❌ 路径不存在: \`${resolved}\`` };
    }

    this.getChannelState(channelId).cwd = resolved;
    return { handled: true, response: `✅ 工作目录已切换到 \`${resolved}\`` };
  }

  private handleMode(channelId: string, args: string): CommandResult {
    if (!args) {
      const current = this.getChannelState(channelId).permissionMode || 'bypassPermissions';
      return {
        handled: true,
        response: `当前权限模式: \`${current}\`\n可选: default, plan, bypassPermissions (bypass)`,
      };
    }

    // 短别名映射
    const modeMap: Record<string, string> = {
      'bypass': 'bypassPermissions',
      'bypasspermissions': 'bypassPermissions',
      'default': 'default',
      'plan': 'plan',
    };

    const mode = modeMap[args.toLowerCase()];
    if (!mode) {
      return { handled: true, response: `❌ 无效模式: \`${args}\`\n可选: default, plan, bypass` };
    }

    this.getChannelState(channelId).permissionMode = mode;
    return { handled: true, response: `✅ 权限模式已切换为 \`${mode}\`` };
  }

  // 执行子进程并捕获 stdout
  private runCLI(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('claude', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
        timeout: 15000,
      });

      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        if (code === 0) resolve(stdout.trim());
        else resolve(stderr.trim() || `退出码: ${code}`);
      });
      proc.on('error', (err) => resolve(`执行失败: ${err.message}`));
    });
  }

  private async handleUsage(): Promise<CommandResult> {
    try {
      const output = await this.runCLI(['usage']);
      return { handled: true, response: `📊 **Claude 用量**\n\`\`\`\n${output}\n\`\`\`` };
    } catch (err) {
      return { handled: true, response: `❌ 获取用量失败: ${err}` };
    }
  }

  private async handleSkills(): Promise<CommandResult> {
    // 扫描 ~/.claude/commands/ 目录下的 .md 文件
    try {
      const skillsDir = path.join(process.env.HOME || '/root', '.claude', 'commands');
      if (existsSync(skillsDir)) {
        const files = readdirSync(skillsDir).filter(f => f.endsWith('.md'));
        if (files.length > 0) {
          const skills = files.map(f => `- /${f.replace('.md', '')}`).join('\n');
          return { handled: true, response: `🛠 **Claude Skills**\n${skills}` };
        }
      }
      return { handled: true, response: '暂无已安装的 Claude Skills' };
    } catch (err) {
      return { handled: true, response: `❌ 获取 skills 失败: ${err}` };
    }
  }

  private async handleMcp(): Promise<CommandResult> {
    try {
      const output = await this.runCLI(['mcp', 'list']);
      return { handled: true, response: `🔌 **MCP Servers**\n\`\`\`\n${output}\n\`\`\`` };
    } catch (err) {
      return { handled: true, response: `❌ 获取 MCP 列表失败: ${err}` };
    }
  }
}
