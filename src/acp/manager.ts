/**
 * ACP Manager
 *
 * Manages Agent Client Protocol sessions. Provides spawn/list/send/steer/kill
 * operations with concurrency limits and cwd whitelist security checks.
 */

import { resolve } from 'path';
import { homedir } from 'os';
import { createLogger } from '../utils/logger.js';
import type { AcpConfig } from '../core/config.js';
import { ClaudeCodeAgent } from './agents/claude-code.js';
import type { CliBackendConfig } from '../ai/cli-backend.js';

const logger = createLogger('acp');

const DEFAULT_MAX_CONCURRENT = 8;

// ---- Public types ----

export type SessionStatus = 'created' | 'running' | 'completed' | 'failed';

export interface AcpSession {
  id: string;
  agentId: string;
  status: SessionStatus;
  cwd?: string;
  prompt?: string;
  createdAt: number;
  lastActiveAt: number;
  /** Collected result text (populated once the session completes). */
  result?: string;
  error?: string;
}

export interface SpawnOptions {
  agentId: string;
  mode?: 'oneshot' | 'session' | 'persistent';
  cwd?: string;
  prompt?: string;
  model?: string;
  timeout?: number;
}

export interface SessionFilter {
  agentId?: string;
  status?: SessionStatus;
}

export interface AcpAgent {
  run(session: AcpSession, prompt: string): Promise<AcpResult>;
}

export interface AcpResult {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
}

// ---- Manager ----

export class ACPManager {
  private readonly sessions = new Map<string, AcpSession>();
  private readonly agents = new Map<string, AcpAgent>();
  private readonly maxConcurrent: number;
  private readonly allowedPaths: string[];
  private sessionCounter = 0;

  constructor(
    private readonly config: AcpConfig,
    cliConfig?: CliBackendConfig,
  ) {
    this.maxConcurrent = config.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT;
    this.allowedPaths = (config.allowedPaths ?? []).map((p) => this.expandPath(p));

    // Register built-in agents
    if (config.allowedAgents?.includes('claude') ?? true) {
      this.agents.set('claude', new ClaudeCodeAgent(cliConfig));
    }

    logger.info('ACPManager initialised', {
      maxConcurrent: this.maxConcurrent,
      allowedPaths: this.allowedPaths,
      agents: [...this.agents.keys()],
    });
  }

  /** Register a custom ACP agent. */
  registerAgent(id: string, agent: AcpAgent): void {
    this.agents.set(id, agent);
  }

  /** Spawn a new agent session. */
  async spawn(options: SpawnOptions): Promise<AcpSession> {
    // Validate agent
    const agentId = options.agentId ?? this.config.defaultAgent ?? 'claude';
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Unknown ACP agent: ${agentId}`);
    }

    // Concurrency check
    const activeSessions = this.getActiveSessions();
    if (activeSessions.length >= this.maxConcurrent) {
      throw new Error(
        `Max concurrent sessions reached (${this.maxConcurrent}). ` +
          `Active: ${activeSessions.length}. Kill a session first.`,
      );
    }

    // cwd whitelist check
    if (options.cwd) {
      this.validateCwd(options.cwd);
    }

    // Create session
    const session: AcpSession = {
      id: this.generateId(),
      agentId,
      status: 'created',
      cwd: options.cwd,
      prompt: options.prompt,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };

    this.sessions.set(session.id, session);
    logger.info('Session spawned', { sessionId: session.id, agentId, cwd: options.cwd });

    // Run in background (fire-and-forget for the caller; status tracked on the session)
    if (options.prompt) {
      void this.runSession(session, agent, options.prompt, options.model, options.timeout);
    }

    return session;
  }

  /** List sessions, optionally filtered. */
  list(filter?: SessionFilter): AcpSession[] {
    let sessions = [...this.sessions.values()];

    if (filter?.agentId) {
      sessions = sessions.filter((s) => s.agentId === filter.agentId);
    }
    if (filter?.status) {
      sessions = sessions.filter((s) => s.status === filter.status);
    }

    return sessions;
  }

  /** Send a follow-up message to an existing session. */
  async send(sessionId: string, message: string): Promise<void> {
    const session = this.getSession(sessionId);
    const agent = this.agents.get(session.agentId);
    if (!agent) {
      throw new Error(`Agent ${session.agentId} not found for session ${sessionId}`);
    }

    session.lastActiveAt = Date.now();
    logger.info('Sending message to session', { sessionId, messageLength: message.length });

    await this.runSession(session, agent, message);
  }

  /** Steer / redirect a running session with a new instruction. */
  async steer(sessionId: string, instruction: string): Promise<void> {
    const session = this.getSession(sessionId);
    const agent = this.agents.get(session.agentId);
    if (!agent) {
      throw new Error(`Agent ${session.agentId} not found for session ${sessionId}`);
    }

    session.lastActiveAt = Date.now();
    logger.info('Steering session', { sessionId, instructionLength: instruction.length });

    // Steer is treated as a high-priority send with a steering prefix
    const steerPrompt = `[STEER] The user wants to redirect this task. New instruction:\n${instruction}`;
    await this.runSession(session, agent, steerPrompt);
  }

  /** Kill / terminate a session. */
  async kill(sessionId: string): Promise<void> {
    const session = this.getSession(sessionId);

    session.status = 'failed';
    session.error = 'Killed by user';
    session.lastActiveAt = Date.now();

    // If the agent supports abort, call it
    const agent = this.agents.get(session.agentId);
    if (agent && 'abort' in agent && typeof (agent as Record<string, unknown>).abort === 'function') {
      (agent as unknown as { abort(sessionId: string): void }).abort(sessionId);
    }

    logger.info('Session killed', { sessionId });
  }

  /** Get a session by ID. Throws if not found. */
  getSession(sessionId: string): AcpSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`ACP session not found: ${sessionId}`);
    }
    return session;
  }

  // ---- Private helpers ----

  private getActiveSessions(): AcpSession[] {
    return [...this.sessions.values()].filter(
      (s) => s.status === 'created' || s.status === 'running',
    );
  }

  private async runSession(
    session: AcpSession,
    agent: AcpAgent,
    prompt: string,
    model?: string,
    timeout?: number,
  ): Promise<void> {
    session.status = 'running';
    session.lastActiveAt = Date.now();

    try {
      const result = await agent.run(session, prompt);
      session.status = result.error ? 'failed' : 'completed';
      session.result = result.text;
      session.error = result.error;
      session.lastActiveAt = Date.now();
      logger.info('Session completed', {
        sessionId: session.id,
        status: session.status,
        usage: result.usage,
      });
    } catch (err) {
      session.status = 'failed';
      session.error = String(err);
      session.lastActiveAt = Date.now();
      logger.error('Session failed', { sessionId: session.id, error: String(err) });
    }
  }

  private validateCwd(cwd: string): void {
    if (this.allowedPaths.length === 0) {
      // No whitelist configured — allow all paths
      return;
    }

    const resolved = resolve(this.expandPath(cwd));
    const isAllowed = this.allowedPaths.some((allowed) => {
      const resolvedAllowed = resolve(allowed);
      return resolved === resolvedAllowed || resolved.startsWith(resolvedAllowed + '/');
    });

    if (!isAllowed) {
      throw new Error(
        `cwd "${cwd}" is not in the allowed paths whitelist: [${this.allowedPaths.join(', ')}]`,
      );
    }
  }

  private expandPath(p: string): string {
    if (p.startsWith('~/') || p === '~') {
      return resolve(homedir(), p.slice(2));
    }
    return resolve(p);
  }

  private generateId(): string {
    this.sessionCounter += 1;
    const ts = Date.now().toString(36);
    const counter = this.sessionCounter.toString(36).padStart(4, '0');
    return `acp_${ts}_${counter}`;
  }
}
