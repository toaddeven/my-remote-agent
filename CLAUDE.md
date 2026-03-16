# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Work Agent is a standalone AI agent (TypeScript/Node.js) that integrates with Feishu (Lark) messaging and LLM providers. It receives messages via Feishu long-polling, maintains conversation sessions and memory, and responds using configurable LLM backends. The project is an ESM-only (`"type": "module"`) Node.js >=20 application.

## Commands

```bash
npm run build          # TypeScript compilation (tsc) to dist/
npm run dev            # Run with tsx (hot reload via src/main.ts)
npm start              # Run compiled dist/index.js
npm test               # Unit tests (vitest, src/**/*.test.ts)
npm run test:watch     # Unit tests in watch mode
npm run test:e2e       # E2E tests (src/**/*.e2e.test.ts, 30s timeout)
npm run test:coverage  # Unit tests with v8 coverage
npm run test:all       # Build + unit + e2e
```

Run a single test file:
```bash
npx vitest run src/session/SessionManager.test.ts --config vitest.unit.config.ts
```

## Architecture

**Entry points:**
- `src/main.ts` — startup script: loads config, creates `WorkAgent`, registers handlers, calls `init()`
- `src/index.ts` — `WorkAgent` class (the orchestrator) + `loadConfig()` / `createDefaultConfig()`
- `src/exports.ts` — barrel re-exports for library consumers

**WorkAgent** (`src/index.ts`) is the central orchestrator that owns and wires together all subsystems:

| Module | Path | Purpose |
|--------|------|---------|
| SessionManager | `src/session/` | Per-channel conversation sessions with message history, TTL, cleanup |
| Memory | `src/memory/` | Short-term / long-term / working memory with `getByPrefix()` for conv record queries |
| QMDStore | `src/memory/QMDStore.ts` | QMD SDK (`@tobilu/qmd`) wrapper — hybrid retrieval (BM25 + vector + LLM reranker) |
| GroupContextBuilder | `src/memory/GroupContextBuilder.ts` | Builds conversation context for both group and private chats |
| ConversationLogger | `src/memory/ConversationLogger.ts` | Daily conversation log generation and Feishu chat persistence |
| LLMClient | `src/llm/` | Multi-provider LLM client (OpenAI, Anthropic, MiniMax, Ollama) with proxy support |
| FeishuClient | `src/feishu/` | Feishu/Lark SDK wrapper — long-polling connection, send/reply messages |
| CronScheduler | `src/cron/` | Cron-based scheduled jobs with named handler registry |
| Heartbeat | `src/heartbeat/` | Periodic health-check runner with named handler registry |
| SubAgentManager | `src/subagent/` | Manages concurrent sub-agent instances with lifecycle control |
| Sandbox | `src/sandbox/` | Sandboxed code execution with timeout and resource limits |
| TaskQueue | `src/queue/` | Priority task queue with concurrency control |
| Autostart | `src/autostart/` | OS-level auto-start registration (macOS launchd / Linux systemd) |

**Message flow (claude-cli mode):** Feishu message → `WorkAgent.handleFeishuMessageCLI()` → store to Memory (`conv:{channelId}:{ts}:{role}`) → index to QMD (fire-and-forget) → GroupContextBuilder.buildContext() (inject recent + semantic-retrieved history) → ClaudeCLIServer.sendMessage() (with `--resume` session) → store assistant reply → reply via FeishuClient.

**Message flow (standard mode):** Feishu message → `WorkAgent.handleFeishuMessage()` → SessionManager (get/create session, add message) → Memory (store short-term) → build context from history + memory → LLMClient.chat() → reply via FeishuClient.

**Configuration:** `config.json` (see `config.example.json`). Loaded at startup and merged with defaults from `createDefaultConfig()`. Types defined in `src/types/index.ts`.

## QMD Integration

QMD (`@tobilu/qmd` v2.0.1) provides hybrid retrieval (BM25 + vector + LLM reranking), fully local with built-in embedding model, no external API needed. Binary at `/opt/homebrew/bin/qmd`.

- **QMDStore** (`src/memory/QMDStore.ts`) wraps the SDK's `createStore` API
- Messages are indexed as markdown documents with frontmatter (`channelId`, `role`, `timestamp`)
- Search supports channel filtering, topK, and minScore threshold (default 0.25)
- Config in `config.json` under `qmd: { enabled, dbPath, collectionName, minScore }`
- Data stored in `./data/qmd/` (SQLite-backed by QMD)

## Context Injection

GroupContextBuilder injects historical conversation context into **both group and private chats** (no chatType restriction). The context is prepended to the user message before sending to the LLM.

- **Recent messages**: last N messages within `recentWindowMinutes` (default 30min, max 20 messages)
- **Older messages**: QMD semantic search (preferred) → keyword matching (fallback) → LLM compression (optional)
- Context format: `[历史摘要]` section + `[近期历史消息]` section

## Session Persistence (Cold Start)

ClaudeCLIServer persists `channelId → sessionId` mappings to `cli-sessions.json` so that `--resume` works across agent restarts. On startup:
1. Memory loads from `data/memory/longterm.json`
2. QMDStore connects to SQLite index
3. ClaudeCLIServer restores session map from disk
4. Cold-start logs report counts: Memory entries, restored sessions, QMD readiness

## Code Conventions

- TypeScript with `strict: false`, target ES2022, NodeNext module resolution
- All imports use `.js` extension (ESM requirement)
- Unit tests are co-located: `Foo.test.ts` alongside `Foo.ts`
- E2E tests use `.e2e.test.ts` suffix
- Chinese comments throughout the codebase (项目使用中文注释)
- Vitest globals are enabled — no need to import `describe`/`it`/`expect`
