/**
 * Claude Code ACP Agent
 *
 * Wraps ClaudeCliBackend as an ACP agent for spawning Claude Code
 * sessions that run coding tasks in the background.
 */

import { ClaudeCliBackend, type CliBackendConfig } from '../../ai/cli-backend.js';
import { createLogger } from '../../utils/logger.js';
import type { AcpAgent, AcpResult, AcpSession } from '../manager.js';

const logger = createLogger('acp:claude-code');

export class ClaudeCodeAgent implements AcpAgent {
  private readonly backend: ClaudeCliBackend;

  constructor(config?: CliBackendConfig) {
    this.backend = new ClaudeCliBackend(config);
  }

  async run(session: AcpSession, prompt: string): Promise<AcpResult> {
    logger.info('Running Claude Code agent', {
      sessionId: session.id,
      cwd: session.cwd,
    });

    let fullText = '';
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let error: string | undefined;

    const messages = [{ role: 'user' as const, content: prompt }];
    const options = {
      cwd: session.cwd,
      sessionId: session.id,
    };

    try {
      for await (const event of this.backend.chat(messages, options)) {
        switch (event.type) {
          case 'text_delta':
            if (event.text) {
              fullText += event.text;
            }
            break;
          case 'done':
            usage = event.usage;
            break;
          case 'error':
            error = event.error;
            break;
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logger.error('Claude Code agent error', { sessionId: session.id, error });
    }

    return { text: fullText, usage, error };
  }

  /** Abort the underlying CLI process. */
  abort(_sessionId: string): void {
    this.backend.abort();
  }
}
