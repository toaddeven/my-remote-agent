/**
 * AI Backend Factory
 *
 * Creates the appropriate AiBackend based on the model configuration.
 */

import type { ModelConfig } from '../core/config.js';
import { AnthropicApiBackend } from './api-backend.js';
import { ClaudeCliBackend } from './cli-backend.js';
import type { AiBackend } from './types.js';

export function createAiBackend(config: ModelConfig): AiBackend {
  if (config.backend === 'cli') {
    return new ClaudeCliBackend({
      path: config.cli?.path,
      timeout: config.cli?.timeout,
      defaultModel: config.default,
    });
  }

  if (!config.apiKey) {
    throw new Error('model.apiKey is required when backend is "api"');
  }

  return new AnthropicApiBackend({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    defaultModel: config.default,
  });
}
