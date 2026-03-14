/**
 * Agent Runner
 *
 * Manages agent lifecycle and handles the message -> AI -> response flow.
 * Integrates with session management and supports streaming responses.
 */

import type { ChatEvent, Message } from '../ai/types.js';
import type { InboundMessage } from '../channels/types.js';
import { createLogger } from '../utils/logger.js';
import type { Agent } from './agent.js';

const logger = createLogger('runner');

/** Callback for streaming events from the runner. */
export type RunnerEventHandler = (event: ChatEvent) => void | Promise<void>;

/** Session context passed to the runner for conversation state. */
export interface SessionContext {
  readonly sessionKey: string;
  readonly agentId: string;
  readonly channelName: string;
  readonly peerId: string;
  readonly peerKind: 'direct' | 'group';
  transcript: Message[];
}

/** Result of a completed runner invocation. */
export interface RunResult {
  readonly text: string;
  readonly usage?: { inputTokens: number; outputTokens: number };
  readonly error?: string;
}

/** Options for a run invocation. */
export interface RunOptions {
  /** Handler called for each streaming event. */
  onEvent?: RunnerEventHandler;
  /** Additional system prompt to prepend. */
  systemPromptOverride?: string;
  /** Timeout override in ms. */
  timeout?: number;
}

export class AgentRunner {
  private readonly agents: Map<string, Agent>;

  constructor(agents?: Iterable<Agent>) {
    this.agents = new Map();
    if (agents) {
      for (const agent of agents) {
        this.agents.set(agent.id, agent);
      }
    }
  }

  /** Register an agent with the runner. */
  registerAgent(agent: Agent): void {
    this.agents.set(agent.id, agent);
    logger.info(`Agent "${agent.id}" registered with runner`);
  }

  /** Retrieve a registered agent by ID. */
  getAgent(agentId: string): Agent | undefined {
    return this.agents.get(agentId);
  }

  /** List all registered agent IDs. */
  listAgentIds(): string[] {
    return Array.from(this.agents.keys());
  }

  /**
   * Run a full message -> AI -> response cycle.
   *
   * @param agentId  - ID of the agent to use
   * @param message  - The inbound message that triggered this run
   * @param session  - Session context with conversation history
   * @param options  - Optional streaming handler and overrides
   * @returns The completed run result
   */
  async run(
    agentId: string,
    message: InboundMessage,
    session: SessionContext,
    options?: RunOptions,
  ): Promise<RunResult> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      const err = `Agent "${agentId}" not found`;
      logger.error(err);
      return { text: '', error: err };
    }

    // Append the new user message to the transcript
    const userMessage: Message = { role: 'user', content: message.text };
    const messages: Message[] = [...session.transcript, userMessage];

    logger.info(`Running agent "${agentId}"`, {
      sessionKey: session.sessionKey,
      turns: messages.length,
      peerId: session.peerId,
    });

    let fullText = '';
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let error: string | undefined;

    try {
      const chatOptions = {
        systemPromptOverride: options?.systemPromptOverride
          ? options.systemPromptOverride
          : undefined,
        timeout: options?.timeout,
      };

      for await (const event of agent.chat(messages, chatOptions)) {
        // Dispatch to optional streaming handler
        if (options?.onEvent) {
          await options.onEvent(event);
        }

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
            logger.warn(`Agent "${agentId}" returned error event`, event.error);
            break;
          // tool_use and tool_result are passed through via onEvent
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logger.error(`Agent "${agentId}" run failed`, error);
    }

    // Update session transcript with the exchange
    session.transcript.push(userMessage);
    if (fullText) {
      session.transcript.push({ role: 'assistant', content: fullText });
    }

    logger.info(`Agent "${agentId}" run complete`, {
      sessionKey: session.sessionKey,
      responseLength: fullText.length,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    });

    return { text: fullText, usage, error };
  }

  /**
   * Run with streaming — returns an async iterable of ChatEvents
   * instead of collecting them into a single result.
   *
   * The caller is responsible for updating the session transcript.
   */
  async *stream(
    agentId: string,
    messages: Message[],
    options?: { systemPromptOverride?: string; timeout?: number },
  ): AsyncIterable<ChatEvent> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      yield { type: 'error', error: `Agent "${agentId}" not found` };
      return;
    }

    logger.info(`Streaming agent "${agentId}"`, { turns: messages.length });

    yield* agent.chat(messages, {
      systemPrompt: options?.systemPromptOverride,
      timeout: options?.timeout,
    });
  }

  /** Abort a running agent. */
  abort(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.abort();
      logger.info(`Agent "${agentId}" aborted via runner`);
    }
  }
}
