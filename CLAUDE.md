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
| Memory | `src/memory/` | Short-term / long-term / working memory with optional vector search (LanceDB) |
| LLMClient | `src/llm/` | Multi-provider LLM client (OpenAI, Anthropic, MiniMax, Ollama) with proxy support |
| FeishuClient | `src/feishu/` | Feishu/Lark SDK wrapper — long-polling connection, send/reply messages |
| CronScheduler | `src/cron/` | Cron-based scheduled jobs with named handler registry |
| Heartbeat | `src/heartbeat/` | Periodic health-check runner with named handler registry |
| SubAgentManager | `src/subagent/` | Manages concurrent sub-agent instances with lifecycle control |
| Sandbox | `src/sandbox/` | Sandboxed code execution with timeout and resource limits |
| TaskQueue | `src/queue/` | Priority task queue with concurrency control |
| Autostart | `src/autostart/` | OS-level auto-start registration (macOS launchd / Linux systemd) |

**Message flow:** Feishu message → `WorkAgent.handleFeishuMessage()` → SessionManager (get/create session, add message) → Memory (store short-term) → build context from history + memory → LLMClient.chat() → reply via FeishuClient.

**Configuration:** `config.json` (see `config.example.json`). Loaded at startup and merged with defaults from `createDefaultConfig()`. Types defined in `src/types/index.ts`.

## Code Conventions

- TypeScript with `strict: false`, target ES2022, NodeNext module resolution
- All imports use `.js` extension (ESM requirement)
- Unit tests are co-located: `Foo.test.ts` alongside `Foo.ts`
- E2E tests use `.e2e.test.ts` suffix
- Chinese comments throughout the codebase (项目使用中文注释)
- Vitest globals are enabled — no need to import `describe`/`it`/`expect`
