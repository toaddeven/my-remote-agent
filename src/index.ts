/**
 * MyAgent Entry Point
 *
 * Wires up all layers: Channel → Router → Queue → Agent Runner → AI Backend
 * and starts listening for messages via Feishu WebSocket.
 */

import { loadConfig } from './core/config.js';
import { FeishuChannel } from './channels/feishu/channel.js';
import { Agent } from './agents/agent.js';
import { AgentRunner } from './agents/runner.js';
import type { SessionContext } from './agents/runner.js';
import { SessionManager } from './core/session.js';
import { MessageQueue } from './core/queue.js';
import { MessageRouter } from './core/router.js';
import type { RouteResult } from './core/router.js';
import type { InboundMessage } from './channels/types.js';
import { ACPManager } from './acp/manager.js';
import { loadSkills, SkillRegistry } from './skills/index.js';
import { createLogger } from './utils/logger.js';
import { TokenTracker } from './utils/token-tracker.js';

const logger = createLogger('main');

async function main(): Promise<void> {
  // 1. Load config
  const config = loadConfig();
  logger.info('Configuration loaded');

  // 2. Create core components
  const sessionManager = new SessionManager(config.session);
  const queue = new MessageQueue(config.messages?.queue);
  const router = new MessageRouter(config, sessionManager, queue);
  const tokenTracker = new TokenTracker();

  // 3. Create agents and runner
  const runner = new AgentRunner();
  for (const agentCfg of config.agents) {
    const agent = new Agent(agentCfg, config.model);
    runner.registerAgent(agent);
  }
  logger.info(`Agents registered: ${runner.listAgentIds().join(', ')}`);

  // 4. Create channel (feishu)
  const feishu = new FeishuChannel(config.feishu);

  // 5. Load skills
  const skillRegistry = new SkillRegistry();
  const globalSkills = await loadSkills('./skills');
  skillRegistry.registerAll(globalSkills);
  for (const agentCfg of config.agents) {
    if (agentCfg.workspace) {
      const workspaceSkills = await loadSkills(`${agentCfg.workspace}/skills`);
      skillRegistry.registerAll(workspaceSkills);
    }
  }
  logger.info(`Skills loaded: ${skillRegistry.size}`);

  // 6. Set up ACP manager (if enabled)
  let acpManager: ACPManager | undefined;
  if (config.acp?.enabled) {
    acpManager = new ACPManager(config.acp, config.model.cli);
    logger.info('ACP manager initialised');
  }

  // 7. Wire up the message processing pipeline:
  //    Channel.onMessage → Router.handleInbound → Queue (debounce) → Router.onRoute → Runner.run → Channel.sendMessage
  router.onRoute(async (route: RouteResult, messages: InboundMessage[], signal: AbortSignal) => {
    const agent = runner.getAgent(route.agentId);
    if (!agent) {
      logger.error(`Agent "${route.agentId}" not found for route`);
      return;
    }

    // Combine batched messages into one text
    const combinedText = messages.map((m) => m.text).join('\n');
    const lastMessage = messages[messages.length - 1]!;

    // Get session context
    const transcript = sessionManager.getContext(route.sessionKey);
    const sessionCtx: SessionContext = {
      sessionKey: route.sessionKey,
      agentId: route.agentId,
      channelName: lastMessage.channelName,
      peerId: lastMessage.peerKind === 'direct' ? lastMessage.userId : lastMessage.chatId,
      peerKind: lastMessage.peerKind,
      transcript,
    };

    // Save user message to session
    await sessionManager.addMessage(route.sessionKey, 'user', combinedText);

    // Build a synthetic inbound message for the runner
    const runMessage: InboundMessage = {
      ...lastMessage,
      text: combinedText,
    };

    logger.info(`Processing message for agent "${route.agentId}"`, {
      sessionKey: route.sessionKey,
      textLength: combinedText.length,
    });

    // Run AI
    const result = await runner.run(route.agentId, runMessage, sessionCtx, {
      onEvent: async (event) => {
        // Check abort
        if (signal.aborted) return;
        // Could stream cards here in the future
      },
    });

    if (signal.aborted) {
      logger.info('Processing aborted, not sending response');
      return;
    }

    // Track token usage
    if (result.usage) {
      const alertTriggered = tokenTracker.record(
        route.sessionKey,
        route.agentId,
        agent.model,
        result.usage.inputTokens,
        result.usage.outputTokens,
      );

      if (alertTriggered) {
        logger.warn('High token usage alert triggered', {
          sessionKey: route.sessionKey,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        });
      }
    }

    // Save assistant response to session
    if (result.text) {
      await sessionManager.addMessage(route.sessionKey, 'assistant', result.text);
    }

    // Send response back to channel
    if (result.text) {
      try {
        await feishu.sendMessage(
          { chatId: lastMessage.chatId, userId: lastMessage.userId },
          {
            text: result.text,
            replyToMessageId: lastMessage.peerKind === 'group' ? lastMessage.id : undefined,
          },
        );
        logger.info('Response sent', {
          sessionKey: route.sessionKey,
          responseLength: result.text.length,
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
        });
      } catch (err) {
        logger.error('Failed to send response', String(err));
      }
    } else if (result.error) {
      logger.error('AI returned error, not sending response', result.error);
    }
  });

  // Connect channel message handler to router
  feishu.onMessage((event) => {
    router.handleInbound(event).catch((err) => {
      logger.error('Error in message routing', String(err));
    });
  });

  // 8. Connect and start listening
  await feishu.connect();
  logger.info('MyAgent started — listening for messages');

  // Graceful shutdown
  async function shutdown(signal: string): Promise<void> {
    logger.info(`Received ${signal}, shutting down...`);
    try {
      router.dispose();
      sessionManager.dispose();
      await feishu.disconnect();
    } catch (err) {
      logger.error('Error during shutdown', String(err));
    }
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Keep references alive
  void skillRegistry;
  void acpManager;
}

main().catch((err: unknown) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
