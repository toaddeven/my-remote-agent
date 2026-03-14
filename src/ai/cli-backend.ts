/**
 * Claude CLI Backend
 *
 * Implements AiBackend by spawning the `claude` CLI process with
 * --output-format stream-json and parsing newline-delimited JSON.
 * Uses spawn() (not exec()) to prevent shell injection.
 */

import { spawn, type ChildProcess } from 'child_process';
import { createLogger } from '../utils/logger.js';
import type { AiBackend, ChatEvent, ChatOptions, Message } from './types.js';

const logger = createLogger('ai:cli');

const DEFAULT_CLI_PATH = 'claude';
const DEFAULT_TIMEOUT_MS = 120_000;

export interface CliBackendConfig {
  path?: string;
  timeout?: number;
  defaultModel?: string;
}

// ---- Claude CLI JSON message types ----

interface CliInit {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model: string;
}

interface CliStreamEvent {
  type: 'stream_event';
  event: {
    type: string;
    index?: number;
    delta?: { type: string; text: string };
  };
  session_id: string;
}

interface CliAssistant {
  type: 'assistant';
  message: {
    content: Array<{ type: string; text?: string }>;
    usage: { input_tokens: number; output_tokens: number };
  };
  session_id: string;
}

interface CliResult {
  type: 'result';
  subtype: 'success' | 'error';
  is_error: boolean;
  result: string;
  usage: { input_tokens: number; output_tokens: number };
  session_id: string;
}

interface CliSystemMessage {
  type: 'system';
  subtype: string;
  [key: string]: unknown;
}

type CliMessage = CliInit | CliStreamEvent | CliAssistant | CliResult | CliSystemMessage;

function isContentDelta(msg: CliMessage): msg is CliStreamEvent {
  if (msg.type !== 'stream_event') return false;
  const ev = (msg as CliStreamEvent).event;
  return ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta';
}

function isResultMessage(msg: CliMessage): msg is CliResult {
  return msg.type === 'result';
}

export class ClaudeCliBackend implements AiBackend {
  private readonly cliPath: string;
  private readonly timeout: number;
  private readonly defaultModel: string;
  private currentProcess: ChildProcess | null = null;
  private aborted = false;

  constructor(config: CliBackendConfig = {}) {
    this.cliPath = config.path ?? DEFAULT_CLI_PATH;
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
    this.defaultModel = config.defaultModel ?? 'claude-opus-4-6';
  }

  async *chat(messages: Message[], options?: ChatOptions): AsyncIterable<ChatEvent> {
    this.aborted = false;

    // Build the prompt from messages; the CLI takes the last user message as the prompt.
    // For multi-turn context we prepend history as a formatted string.
    const prompt = this.buildPrompt(messages, options?.systemPrompt);
    const model = this.resolveModel(options?.model);
    const args = this.buildArgs(prompt, model, options);

    logger.info('Starting CLI chat', { model, turns: messages.length });

    yield* this.runProcess(args, options?.cwd, options?.timeout);
  }

  private async *runProcess(
    args: string[],
    cwd?: string,
    timeout?: number,
  ): AsyncIterable<ChatEvent> {
    const effectiveTimeout = timeout ?? this.timeout;

    // Use an async generator with a queue pattern
    const queue: Array<ChatEvent> = [];
    let finished = false;
    let resolveNext: (() => void) | null = null;

    const push = (event: ChatEvent): void => {
      queue.push(event);
      resolveNext?.();
      resolveNext = null;
    };

    const waitForItem = (): Promise<void> =>
      new Promise((resolve) => {
        if (queue.length > 0 || finished) {
          resolve();
        } else {
          resolveNext = resolve;
        }
      });

    let proc: ChildProcess;
    try {
      proc = spawn(this.cliPath, args, {
        cwd: cwd ?? process.cwd(),
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      yield { type: 'error', error: `Failed to spawn CLI: ${String(err)}` };
      return;
    }

    this.currentProcess = proc;

    const timeoutHandle = setTimeout(() => {
      logger.warn('CLI process timed out', { timeout: effectiveTimeout });
      push({ type: 'error', error: `CLI process timed out after ${effectiveTimeout}ms` });
      proc.kill('SIGTERM');
    }, effectiveTimeout);

    proc.stdin?.end();

    let buffer = '';
    let inputTokens = 0;
    let outputTokens = 0;

    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let msg: CliMessage;
        try {
          msg = JSON.parse(trimmed) as CliMessage;
        } catch {
          logger.debug('Skipping non-JSON line from CLI', trimmed.slice(0, 100));
          continue;
        }

        if (isContentDelta(msg)) {
          const text = (msg as CliStreamEvent).event.delta?.text ?? '';
          if (text) push({ type: 'text_delta', text });
        } else if (isResultMessage(msg)) {
          const result = msg as CliResult;
          inputTokens = result.usage.input_tokens;
          outputTokens = result.usage.output_tokens;
          if (result.is_error) {
            push({ type: 'error', error: result.result });
          }
        }
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) logger.debug('CLI stderr', text.slice(0, 200));
    });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timeoutHandle);
      const message =
        err.code === 'ENOENT'
          ? `Claude CLI not found at "${this.cliPath}". Install with: npm install -g @anthropic-ai/claude-code`
          : err.message;
      push({ type: 'error', error: message });
      finished = true;
      resolveNext?.();
    });

    proc.on('close', (code) => {
      clearTimeout(timeoutHandle);
      this.currentProcess = null;
      logger.info('CLI process exited', { code });

      // Flush remaining buffer
      if (buffer.trim()) {
        try {
          const msg = JSON.parse(buffer.trim()) as CliMessage;
          if (isResultMessage(msg)) {
            const result = msg as CliResult;
            inputTokens = result.usage.input_tokens;
            outputTokens = result.usage.output_tokens;
          }
        } catch {
          // ignore
        }
      }

      if (code !== 0 && code !== null && !this.aborted) {
        push({ type: 'error', error: `CLI process exited with code ${code}` });
      } else {
        push({ type: 'done', usage: { inputTokens, outputTokens } });
      }

      finished = true;
      resolveNext?.();
    });

    // Drain the queue
    while (true) {
      await waitForItem();
      while (queue.length > 0) {
        const event = queue.shift()!;
        yield event;
        if (event.type === 'done' || event.type === 'error') return;
      }
      if (finished && queue.length === 0) return;
    }
  }

  abort(): void {
    if (this.currentProcess) {
      this.aborted = true;
      this.currentProcess.kill('SIGTERM');
      this.currentProcess = null;
      logger.info('CLI process aborted');
    }
  }

  private buildPrompt(messages: Message[], systemPrompt?: string): string {
    // For multi-turn: format history as a text block prepended to the last user message.
    // The CLI doesn't natively support message history, so we inline it.
    if (messages.length === 0) return '';

    const parts: string[] = [];

    if (systemPrompt) {
      parts.push(`<system>\n${systemPrompt}\n</system>\n`);
    }

    // Include all prior turns as context
    const history = messages.slice(0, -1);
    if (history.length > 0) {
      for (const msg of history) {
        const role = msg.role === 'user' ? 'Human' : 'Assistant';
        parts.push(`${role}: ${msg.content}`);
      }
      parts.push('');
    }

    const last = messages[messages.length - 1];
    if (last) {
      parts.push(last.content);
    }

    return parts.join('\n');
  }

  private buildArgs(prompt: string, model: string, options?: ChatOptions): string[] {
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model', model,
      '--no-session-persistence',
    ];

    if (options?.sessionId) {
      args.push('--session-id', options.sessionId);
    }

    args.push(prompt);

    return args;
  }

  private resolveModel(model?: string): string {
    if (!model) return this.defaultModel;
    // Strip "anthropic/" prefix if present
    return model.startsWith('anthropic/') ? model.slice('anthropic/'.length) : model;
  }
}
