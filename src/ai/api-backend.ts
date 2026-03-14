/**
 * Anthropic API Backend
 *
 * Implements AiBackend using @anthropic-ai/sdk with streaming.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream.js';
import { createLogger } from '../utils/logger.js';
import type { AiBackend, ChatEvent, ChatOptions, Message } from './types.js';

const logger = createLogger('ai:api');

const DEFAULT_MODEL = 'claude-opus-4-6';
const DEFAULT_MAX_TOKENS = 4096;

export interface ApiBackendConfig {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}

export class AnthropicApiBackend implements AiBackend {
  private readonly client: Anthropic;
  private readonly defaultModel: string;
  private currentStream: MessageStream | null = null;

  constructor(config: ApiBackendConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
    this.defaultModel = config.defaultModel ?? DEFAULT_MODEL;
  }

  async *chat(messages: Message[], options?: ChatOptions): AsyncIterable<ChatEvent> {
    const model = this.resolveModel(options?.model);
    const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;

    const anthropicMessages: Anthropic.MessageParam[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    logger.info(`Starting API chat`, { model, turns: messages.length });

    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const streamParams: Anthropic.MessageStreamParams = {
        model,
        max_tokens: maxTokens,
        messages: anthropicMessages,
      };

      if (options?.systemPrompt) {
        streamParams.system = options.systemPrompt;
      }

      const stream = this.client.messages.stream(streamParams);
      this.currentStream = stream;

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'text_delta', text: event.delta.text };
        } else if (event.type === 'message_start' && event.message.usage) {
          inputTokens = event.message.usage.input_tokens;
        } else if (event.type === 'message_delta' && event.usage) {
          outputTokens = event.usage.output_tokens;
        }
      }

      yield {
        type: 'done',
        usage: { inputTokens, outputTokens },
      };

      logger.info(`API chat complete`, { inputTokens, outputTokens });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`API chat error`, message);
      yield { type: 'error', error: message };
    } finally {
      this.currentStream = null;
    }
  }

  abort(): void {
    if (this.currentStream) {
      this.currentStream.controller.abort();
      this.currentStream = null;
      logger.info('API stream aborted');
    }
  }

  private resolveModel(model?: string): string {
    if (!model) return this.defaultModel;
    // Strip "anthropic/" prefix if present
    return model.startsWith('anthropic/') ? model.slice('anthropic/'.length) : model;
  }
}
