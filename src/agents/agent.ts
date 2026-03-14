/**
 * Agent base class
 *
 * Encapsulates agent configuration (name, model, systemPrompt, tools),
 * state management, and integration with AiBackend.
 */

import type { AiBackend, ChatOptions, Message } from '../ai/types.js';
import type { AgentConfig, ModelConfig } from '../core/config.js';
import { createAiBackend } from '../ai/factory.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('agent');

/** Runtime state of an agent. */
export type AgentStatus = 'idle' | 'busy' | 'error';

/** Tool definition that can be registered with an agent. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

/** Resolved agent configuration with defaults applied. */
export interface ResolvedAgentConfig {
  readonly id: string;
  readonly model: string;
  readonly workspace: string;
  readonly systemPrompt: string;
  readonly tools: ToolDefinition[];
}

export class Agent {
  readonly id: string;
  readonly model: string;
  readonly workspace: string;
  readonly systemPrompt: string;
  readonly tools: ToolDefinition[];

  private readonly backend: AiBackend;
  private _status: AgentStatus = 'idle';

  constructor(agentConfig: AgentConfig, modelConfig: ModelConfig) {
    this.id = agentConfig.id;
    this.model = agentConfig.model ?? modelConfig.default ?? 'anthropic/claude-opus-4-6';
    this.workspace = agentConfig.workspace ?? './workspace';
    this.systemPrompt = agentConfig.systemPrompt ?? '';
    this.tools = [];

    // Create a backend instance for this agent.
    // If the agent specifies a model, override the model config default.
    const effectiveModelConfig: ModelConfig = {
      ...modelConfig,
      default: this.model,
    };
    this.backend = createAiBackend(effectiveModelConfig);

    logger.info(`Agent "${this.id}" created`, { model: this.model, workspace: this.workspace });
  }

  /** Current runtime status. */
  get status(): AgentStatus {
    return this._status;
  }

  /** The underlying AI backend for this agent. */
  getBackend(): AiBackend {
    return this.backend;
  }

  /** Register a tool with this agent. */
  addTool(tool: ToolDefinition): void {
    this.tools.push(tool);
    logger.debug(`Tool "${tool.name}" registered for agent "${this.id}"`);
  }

  /** Build ChatOptions from the agent's configuration. */
  buildChatOptions(overrides?: Partial<ChatOptions>): ChatOptions {
    return {
      model: this.model,
      systemPrompt: this.systemPrompt || undefined,
      cwd: this.workspace,
      ...overrides,
    };
  }

  /**
   * Send messages to the AI backend and yield streaming events.
   * Manages the agent's busy/idle status automatically.
   */
  async *chat(messages: Message[], options?: Partial<ChatOptions>): AsyncIterable<import('../ai/types.js').ChatEvent> {
    if (this._status === 'busy') {
      logger.warn(`Agent "${this.id}" is already busy`);
    }

    this._status = 'busy';
    const chatOptions = this.buildChatOptions(options);

    try {
      yield* this.backend.chat(messages, chatOptions);
      this._status = 'idle';
    } catch (err) {
      this._status = 'error';
      logger.error(`Agent "${this.id}" chat error`, String(err));
      throw err;
    }
  }

  /** Abort the current AI request. */
  abort(): void {
    this.backend.abort();
    this._status = 'idle';
    logger.info(`Agent "${this.id}" aborted`);
  }

  /** Returns the resolved configuration snapshot. */
  toConfig(): ResolvedAgentConfig {
    return {
      id: this.id,
      model: this.model,
      workspace: this.workspace,
      systemPrompt: this.systemPrompt,
      tools: [...this.tools],
    };
  }
}
