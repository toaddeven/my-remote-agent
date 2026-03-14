# MyAgent — 轻量级个人 AI 助理

## 项目概述

基于 Node.js + TypeScript 的个人 AI 助理，通过飞书 WebSocket 长连接通信，无 Gateway 架构。

## 技术栈

- **运行时**: Node.js ≥ 22, ESM
- **语言**: TypeScript (strict mode)
- **飞书 SDK**: `@larksuiteoapi/node-sdk` (WebSocket 长连接)
- **AI 引擎**: `@anthropic-ai/sdk` (API) + `claude` CLI (CLI 模式)
- **存储**: 本地文件 (JSONL)
- **构建**: tsc / esbuild

## 架构

```
飞书 WebSocket → Channel 层 → Core 层 → AI 引擎 (API/CLI)
```

三层架构：
1. **Channel 层** — 消息渠道抽象。MVP 仅实现飞书，但接口支持扩展
2. **Core 层** — 消息路由、会话管理、Agent 管理、消息排队
3. **AI 层** — 双后端：Anthropic API (`@anthropic-ai/sdk`) + Claude CLI 子进程

## 目录结构

```
src/
├── index.ts              # 入口
├── core/
│   ├── app.ts            # 应用主类
│   ├── router.ts         # 消息路由 (去重、防抖、Agent 匹配)
│   ├── session.ts        # 会话管理 (上下文、JSONL 持久化)
│   ├── queue.ts          # 消息排队 (followup/steer/interrupt)
│   └── config.ts         # 配置加载 (支持 ${ENV_VAR} 注入)
├── channels/
│   ├── types.ts          # Channel 接口定义
│   └── feishu/
│       ├── channel.ts    # 飞书 Channel 实现
│       ├── events.ts     # 事件解析
│       ├── send.ts       # 消息发送
│       ├── mention.ts    # @提及处理
│       └── card.ts       # 卡片消息 (流式输出)
├── agents/
│   ├── agent.ts          # Agent 基类
│   ├── runner.ts         # Agent 运行器
│   └── binding.ts        # 路由绑定
├── ai/
│   ├── types.ts          # AiBackend 接口 + ChatEvent 类型
│   ├── api-backend.ts    # Anthropic API 后端
│   ├── cli-backend.ts    # Claude CLI 后端 (spawn, stream-json)
│   └── factory.ts        # createAiBackend() 工厂
├── acp/
│   ├── manager.ts        # ACP Manager (spawn/list/send/kill)
│   └── agents/
│       └── claude-code.ts # Claude Code Agent (复用 cli-backend)
├── skills/
│   ├── loader.ts         # 技能加载
│   └── registry.ts       # 技能注册
└── utils/
    └── logger.ts         # structured logging
```

## 核心接口

### Channel 接口
```typescript
interface Channel {
  readonly name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  sendMessage(target: MessageTarget, content: OutboundMessage): Promise<string>;
  onMessage(handler: (event: InboundEvent) => void): void;
  sendCard?(target: MessageTarget, card: CardContent): Promise<string>;
  updateCard?(messageId: string, card: CardContent): Promise<void>;
}
```

### AI Backend 接口
```typescript
interface AiBackend {
  chat(messages: Message[], options?: ChatOptions): AsyncIterable<ChatEvent>;
  abort(): void;
}

interface ChatEvent {
  type: 'text_delta' | 'tool_use' | 'tool_result' | 'done' | 'error';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
}
```

### ACP Manager 接口
```typescript
interface AcpManager {
  spawn(options: SpawnOptions): Promise<AcpSession>;
  list(filter?: SessionFilter): AcpSession[];
  send(sessionId: string, message: string): Promise<void>;
  steer(sessionId: string, instruction: string): Promise<void>;
  kill(sessionId: string): Promise<void>;
}
```

## 配置文件 (config.json)

```json
{
  "feishu": {
    "appId": "${FEISHU_APP_ID}",
    "appSecret": "${FEISHU_APP_SECRET}",
    "domain": "feishu",
    "botName": "MyAgent"
  },
  "model": {
    "backend": "cli",
    "default": "anthropic/claude-opus-4-6",
    "apiKey": "${ANTHROPIC_API_KEY}",
    "baseUrl": "https://api.anthropic.com",
    "cli": {
      "path": "claude",
      "timeout": 120000
    }
  },
  "agents": [
    {
      "id": "main",
      "model": "anthropic/claude-opus-4-6",
      "workspace": "./workspace"
    }
  ],
  "bindings": [
    {
      "agentId": "main",
      "match": { "channel": "feishu", "peer": { "kind": "direct" } }
    }
  ],
  "session": {
    "dmScope": "per-peer",
    "reset": { "kind": "daily", "time": "04:00" }
  },
  "messages": {
    "queue": { "mode": "followup", "debounceMs": 800 }
  },
  "acp": {
    "enabled": true,
    "defaultAgent": "claude",
    "allowedAgents": ["claude"],
    "maxConcurrentSessions": 8,
    "allowedPaths": ["~/work", "~/projects"]
  }
}
```

配置优先级：`agents[].model` > `model.default` > 内置默认值

## 消息处理流程

1. **消息解析** — 解析飞书事件，提取文本、@提及、媒体
2. **去重** — message_id 去重
3. **防抖** — 连续消息合并 (默认 800ms)
4. **路由** — channel + chatId/userId 匹配 Agent
5. **会话** — 加载上下文 (JSONL)
6. **AI 调用** — 发给 Claude (注入 system prompt + 工具 + 历史)
7. **响应** — 格式化回复，飞书 API 发送
8. **持久化** — 保存到 JSONL

## Claude CLI 后端

通过 `claude --print --output-format stream-json` 调用，使用 `spawn()` (非 `exec()`)。

事件类型：`system(init)` → `stream_event(content_block_delta)` → `assistant` → `result`

参考实现：`~/work/claude-api`

## 安全要求

- 配置中敏感字段用 `${ENV_VAR}` 环境变量注入
- ACP cwd 限制在白名单路径内
- CLI 调用始终用 `spawn()` 防注入
- JSONL 写入后 fsync

## 非功能性需求

- 消息响应 < 2s (首字节)
- 最大并发 10 条消息
- WebSocket 断线自动重连 (指数退避)
- 内存 < 200MB (稳态)
- 启动 < 3s
- 日志按天轮转，保留 14 天

## 开发阶段

当前任务：**Phase 1 — 核心框架**

Phase 1 目标：
- [ ] 项目初始化 (TypeScript + ESM)
- [ ] 配置系统 (config.json 加载/验证，${ENV_VAR} 注入)
- [ ] Channel 接口定义
- [ ] 飞书 WebSocket 长连接实现
- [ ] 消息收发 (文本)
- [ ] AI Backend 抽象 + API 模式 + CLI 模式
- [ ] 基础会话管理 (上下文保持)

## 代码规范

- 不要有 "openclaw" 字样
- TypeScript strict mode
- ESM (import/export)
- 错误处理：WebSocket 断连自动重连，CLI 进程崩溃恢复
- 日志：structured logging (timestamp + level + module + message)

## 参考

- PRD 完整文档：`./PRD.md`
- Claude CLI 参考实现：`~/work/claude-api`
