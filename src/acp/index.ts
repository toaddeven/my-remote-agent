/**
 * ACP — Agent Client Protocol
 *
 * Barrel file exporting the public ACP API.
 */

export { ACPManager } from './manager.js';
export type {
  AcpAgent,
  AcpResult,
  AcpSession,
  SessionFilter,
  SessionStatus,
  SpawnOptions,
} from './manager.js';

export { ClaudeCodeAgent } from './agents/claude-code.js';
