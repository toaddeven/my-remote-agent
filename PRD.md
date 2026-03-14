# MyAgent 产品需求文档 (PRD)

> **版本**: v0.6
> **日期**: 2026-03-14
> **状态**: 评审中

---

## 1. 项目概述

### 1.1 产品名称
**MyAgent** — 轻量级个人 AI 助理

### 1.2 项目定位
一个自研的、轻量级个人 AI 助理系统。通过飞书长连接直接与用户通信，无需复杂的 Gateway 架构。支持多 Agent、技能扩展，可本地部署运行。

### 1.3 设计原则
- **简洁优先** — 去掉不必要的抽象层，直连飞书
- **可扩展** — Channel 层接口化，便于未来扩展其他渠道
- **本地运行** — 无需云服务，数据全部本地
- **AI 原生** — 以大模型对话为核心，工具和技能为辅助

---

## 2. 功能规划

### 2.1 MVP 功能 (Phase 1)

| 功能 | 说明 | 优先级 |
|------|------|--------|
| **飞书消息收发** | 通过 WebSocket 长连接收发私聊 + 群聊消息 | P0 |
| **AI 对话** | 接入 Anthropic Claude，支持多轮对话 | P0 |
| **会话管理** | 会话隔离（私聊/群聊），上下文管理 | P0 |
| **配置系统** | JSON 配置文件，支持模型、渠道、Agent 配置 | P0 |
| **消息类型** | 文本收发，@提及识别 | P0 |

### 2.2 扩展功能 (Phase 2)

| 功能 | 说明 | 优先级 |
|------|------|--------|
| **技能系统** | 可插拔技能，SKILL.md 定义 | P1 |
| **多 Agent** | 不同群/用户绑定不同 Agent | P1 |
| **富文本消息** | 图片、文件收发 | P1 |
| **工具调用** | 文件读写、Shell 执行、Web 搜索等 | P1 |
| **流式响应** | 卡片流式输出，实时显示 AI 回复 | P1 |

### 2.3 后续可扩展 (Phase 3+)

| 功能 | 说明 |
|------|------|
| 定时任务 (Cron) | 定时检查、提醒 |
| 知识库 (RAG) | 本地文档检索 |
| 浏览器控制 | 自动化网页操作 |
| 其他渠道 | 通过 Channel 层扩展 Telegram/Slack 等 |

### 2.4 明确不做的功能

| 功能 | 原因 |
|------|------|
| Gateway 架构 | 过于复杂，直连即可 |
| HTTP Webhook 模式 | 仅用 WebSocket 长连接 |
| 多渠道支持 (MVP) | 聚焦飞书，但预留 Channel 接口 |
| 设备节点控制 | 不需要远程设备管理 |
| 复杂安全沙箱 | 简化部署，本地信任 |

---

## 3. 系统架构

### 3.1 整体架构

```
┌─────────────────────────────────────────┐
│              飞书平台                    │
│     (WebSocket 长连接 / REST API)       │
└─────────────────┬───────────────────────┘
                  │ WebSocket
                  ▼
┌─────────────────────────────────────────┐
│            Channel 层                   │
│   ┌──────────────────────────────┐      │
│   │      FeishuChannel           │      │
│   │  • WebSocket 连接管理        │      │
│   │  • 消息解析 & 格式化         │      │
│   │  • @提及处理                 │      │
│   │  • 卡片流式输出              │      │
│   └──────────────────────────────┘      │
└─────────────────┬───────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│             Core 层                     │
│  ┌────────────┐  ┌──────────────────┐   │
│  │ 消息路由    │  │   会话管理        │   │
│  │ • 去重      │  │   • 上下文        │   │
│  │ • 防抖      │  │   • 隔离          │   │
│  │ • 排队      │  │   • 持久化        │   │
│  └────────────┘  └──────────────────┘   │
│  ┌────────────┐  ┌──────────────────┐   │
│  │ Agent 管理  │  │   工具系统        │   │
│  │ • 多Agent   │  │   • 工具注册      │   │
│  │ • 绑定路由  │  │   • 权限控制      │   │
│  └────────────┘  └──────────────────┘   │
└─────────────────┬───────────────────────┘
                  │
      ┌───────────┼───────────┐
      ▼           ▼           ▼
┌──────────┐ ┌──────────┐ ┌──────────┐
│  AI 引擎  │ │  技能系统  │ │ Workspace │
│ Claude   │ │ Skills   │ │  文件存储  │
└──────────┘ └──────────┘ └──────────┘
```

### 3.2 Channel 层设计

Channel 是消息渠道的抽象接口。MVP 仅实现飞书，但接口设计支持未来扩展。

```typescript
// Channel 抽象接口
interface Channel {
  readonly name: string;

  // 生命周期
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // 消息收发
  sendMessage(target: MessageTarget, content: OutboundMessage): Promise<string>;
  onMessage(handler: (event: InboundEvent) => void): void;

  // 可选能力
  sendCard?(target: MessageTarget, card: CardContent): Promise<string>;
  updateCard?(messageId: string, card: CardContent): Promise<void>;
}

// 消息目标
interface MessageTarget {
  type: 'user' | 'group';
  id: string;                    // open_id 或 chat_id
}

// 入站事件
interface InboundEvent {
  messageId: string;
  chatId: string;
  chatType: 'private' | 'group';
  sender: {
    userId: string;
    name?: string;
  };
  content: {
    type: 'text' | 'image' | 'file' | 'audio';
    text?: string;
    mediaKey?: string;
  };
  mentions?: Array<{ userId: string; name: string }>;
  replyTo?: { messageId: string };
  timestamp: number;
}

// 出站消息
interface OutboundMessage {
  type: 'text' | 'image' | 'file' | 'card';
  text?: string;
  mediaPath?: string;
  card?: CardContent;
}
```

### 3.3 飞书 Channel 实现

```typescript
class FeishuChannel implements Channel {
  name = 'feishu';

  private client: lark.Client;
  private wsClient: lark.WSClient;

  constructor(config: FeishuConfig) {
    this.client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: config.domain || lark.Domain.Feishu,
    });
  }

  async connect(): Promise<void> {
    // 通过飞书 SDK 建立 WebSocket 长连接
    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: this.config.domain || lark.Domain.Feishu,
    });

    this.wsClient.start({
      eventDispatcher: new lark.EventDispatcher({}).register({
        'im.message.receive_v1': (data) => this.handleMessage(data),
      }),
    });
  }

  async sendMessage(target: MessageTarget, content: OutboundMessage): Promise<string> {
    // 调用飞书 REST API 发送消息
    const res = await this.client.im.message.create({
      data: {
        receive_id: target.id,
        msg_type: content.type === 'text' ? 'text' : 'interactive',
        content: this.formatContent(content),
      },
      params: {
        receive_id_type: target.type === 'user' ? 'open_id' : 'chat_id',
      },
    });
    return res.data.message_id;
  }
}
```

### 3.4 会话管理

```typescript
// 会话 Key 格式
// 私聊: agent:<agentId>:feishu:dm:<userId>
// 群聊: agent:<agentId>:feishu:group:<chatId>

interface Session {
  key: string;
  agentId: string;
  channelName: string;
  chatType: 'private' | 'group';
  peerId: string;              // userId 或 chatId
  transcript: Message[];       // 对话历史
  createdAt: number;
  lastActiveAt: number;
}

// 会话存储
// ~/.my-agent/sessions/<sessionKey>.jsonl
// 每行一条消息，JSONL 格式
```

### 3.5 Agent 系统

```typescript
interface AgentConfig {
  id: string;                    // 如 "main"
  model: string;                 // 如 "anthropic/claude-opus-4-6"
  workspace: string;             // 工作目录
  skills?: string[];             // 允许的技能列表
  systemPrompt?: string;         // 系统提示（从 AGENTS.md + SOUL.md 注入）
}

// Agent 绑定路由
interface Binding {
  agentId: string;
  match: {
    channel: string;
    peer: {
      kind: 'direct' | 'group';
      id?: string;               // 指定用户/群 ID
    };
  };
}
```

### 3.6 技能系统

技能是可插拔的功能模块，每个技能是一个目录，包含 `SKILL.md` 描述文件。

```
~/.my-agent/skills/
├── weather/
│   └── SKILL.md
├── web-search/
│   └── SKILL.md
└── file-manager/
    └── SKILL.md
```

技能加载优先级：
1. Agent workspace skills（最高优先级）
2. 全局 skills 目录
3. 内置 skills（最低优先级）

---

## 4. 核心消息流程

### 4.1 消息处理流程

```
飞书 WebSocket 收到消息
    ↓
[1. 消息解析] 解析飞书事件格式，提取文本、@提及、媒体
    ↓
[2. 去重] 根据 message_id 去重，防止重复处理
    ↓
[3. 防抖] 连续消息合并（可配置，默认 800ms）
    ↓
[4. 路由] 根据 channel + chatId/userId 匹配 Agent
    ↓
[5. 会话] 加载会话上下文（历史消息）
    ↓
[6. AI 调用] 发送给 Claude，获取回复
    ├── 注入系统提示（AGENTS.md + SOUL.md）
    ├── 注入工具定义
    ├── 注入会话历史
    └── 处理工具调用（循环执行）
    ↓
[7. 响应] 格式化回复，通过飞书 API 发送
    ├── 文本消息
    ├── 卡片消息（流式）
    └── 媒体消息
    ↓
[8. 持久化] 保存消息到会话文件 (JSONL)
```

### 4.2 消息排队策略

当 Agent 正在处理一条消息时，新消息的处理策略：

| 模式 | 行为 |
|------|------|
| `followup` | 排队等待当前处理完成后再处理（默认） |
| `steer` | 将新消息注入当前正在进行的对话 |
| `interrupt` | 中断当前处理，开始新的处理 |

---

## 5. 配置设计

### 5.1 主配置文件 (`config.json`)

```json
{
  "feishu": {
    "appId": "cli_xxx",
    "appSecret": "xxx",
    "domain": "feishu",
    "botName": "MyAgent"
  },
  "model": {
    "default": "anthropic/claude-opus-4-6",
    "apiKey": "sk-ant-xxx",
    "baseUrl": "https://api.anthropic.com"
  },
  "agents": [
    {
      "id": "main",
      "model": "anthropic/claude-opus-4-6",  // 优先级高于 model.default
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
    "reset": {
      "kind": "daily",
      "time": "04:00"
    }
  },
  "messages": {
    "queue": {
      "mode": "followup",
      "debounceMs": 800
    }
  }
}
```

### 5.2 配置优先级

模型配置优先级（从高到低）：
1. `agents[].model` — Agent 级别指定模型
2. `model.default` — 全局默认模型
3. 内置默认值（`anthropic/claude-opus-4-6`）

`bindings[].match.peer.id` 为空或省略时，匹配该 `kind` 下所有对话（即通配符）。

### 5.3 Workspace 文件

```
workspace/
├── AGENTS.md      # Agent 行为指令
├── SOUL.md        # Agent 人格定义
├── TOOLS.md       # 工具使用备注
├── IDENTITY.md    # Agent 身份信息
├── USER.md        # 用户信息
└── MEMORY.md      # 长期记忆
```

---

## 6. 目录结构

```
my-agent/
├── src/
│   ├── index.ts              # 入口
│   ├── core/
│   │   ├── app.ts            # 应用主类
│   │   ├── router.ts         # 消息路由
│   │   ├── session.ts        # 会话管理
│   │   ├── queue.ts          # 消息排队
│   │   └── config.ts         # 配置加载
│   ├── channels/
│   │   ├── types.ts          # Channel 接口定义
│   │   └── feishu/
│   │       ├── channel.ts    # 飞书 Channel 实现
│   │       ├── events.ts     # 事件解析
│   │       ├── send.ts       # 消息发送
│   │       ├── mention.ts    # @提及处理
│   │       └── card.ts       # 卡片消息
│   ├── agents/
│   │   ├── agent.ts          # Agent 基类
│   │   ├── runner.ts         # Agent 运行器
│   │   └── binding.ts        # 路由绑定
│   ├── ai/
│   │   ├── client.ts         # AI 客户端 (Claude API)
│   │   ├── tools.ts          # 工具定义
│   │   └── stream.ts         # 流式响应
│   └── skills/
│       ├── loader.ts         # 技能加载
│       └── registry.ts       # 技能注册
├── workspace/                 # 默认工作区
│   ├── AGENTS.md
│   ├── SOUL.md
│   └── TOOLS.md
├── config.json               # 配置文件
├── package.json
├── tsconfig.json
└── README.md
```

---

## 7. 技术选型

| 组件 | 技术 | 说明 |
|------|------|------|
| 运行时 | Node.js ≥ 22 | 现代 Node，支持 ESM |
| 语言 | TypeScript | 类型安全 |
| 飞书 SDK | @larksuiteoapi/node-sdk | 官方 SDK，支持 WebSocket |
| AI 引擎 | @anthropic-ai/sdk | Anthropic Claude API |
| 消息连接 | 飞书 WebSocket 长连接 | 实时双向通信 |
| 存储 | 本地文件 (JSONL) | 会话和配置 |
| 构建 | esbuild / tsc | 快速编译 |

---

## 8. 开发计划

### Phase 1: 核心框架 (2 周)
- [ ] 项目初始化 (TypeScript + ESM)
- [ ] 配置系统 (config.json 加载/验证，含环境变量注入)
- [ ] Channel 接口定义
- [ ] 飞书 WebSocket 长连接实现
- [ ] 消息收发 (文本)
- [ ] Claude API/CLI 双后端对话集成
- [ ] 基础会话管理 (上下文保持)

### Phase 2: 完善核心 (2 周)
- [ ] 消息去重和防抖
- [ ] 消息排队策略
- [ ] 多 Agent 支持和路由绑定
- [ ] @提及处理
- [ ] Workspace 文件注入 (AGENTS.md, SOUL.md)
- [ ] 会话持久化 (JSONL) + 归档清理
- [ ] 日志系统 (structured logging)

### Phase 3: ACP 系统 (1 周)
- [ ] ACP Manager 核心实现
- [ ] Claude Code Agent 集成（复用 ClaudeCliBackend）
- [ ] spawn / list / send / kill 基础操作
- [ ] 飞书消息触发 → ACP 会话 + 状态通知

### Phase 4: 技能系统 (1 周)
- [ ] 技能加载框架
- [ ] 工具调用系统
- [ ] 基础内置工具 (文件读写、Shell、Web 搜索)
- [ ] 卡片流式响应
- [ ] CLI 命令行接口 (`my-agent exec / session`)

---

## 9. 非功能性需求

| 需求 | 指标 |
|------|------|
| 消息响应时间 | < 2s (首字节) |
| 最大并发消息 | 同时处理 ≤ 10 条消息（超出排队） |
| WebSocket 断线重连 | 自动重连，指数退避 |
| 会话历史 | 本地 JSONL 持久化 |
| 内存占用 | < 200MB (稳态) |
| 启动时间 | < 3s |
| 日志轮转 | 按天轮转，保留最近 14 天，单文件 ≤ 50MB |

---

## 10. 风险与应对

| 风险 | 影响 | 应对方案 |
|------|------|----------|
| 飞书 WebSocket 断连 | 消息丢失 | 自动重连 + 指数退避 |
| 飞书 API 限流 | 发送失败 | 限流队列 + 重试 |
| Claude API 超时 | 响应慢 | 超时处理 + 重试 |
| 会话文件过大 | 磁盘/性能 | 定期清理 + 上下文裁剪 |

---

## 11. 验收标准

### MVP 验收 (Phase 1)
- [ ] 飞书机器人通过 WebSocket 长连接成功上线
- [ ] 私聊消息正常收发
- [ ] 群聊 @提及后正常回复
- [ ] Claude 多轮对话正常
- [ ] 配置文件可自定义模型和飞书凭证

### Phase 2 验收
- [ ] 多 Agent 路由正常
- [ ] 消息去重、防抖正常
- [ ] WebSocket 断线自动重连
- [ ] 会话隔离正确（私聊/群聊独立）
- [ ] 会话归档和清理正常
- [ ] structured logging 输出正常

### Phase 3 验收
- [ ] ACP spawn/list/kill 正常
- [ ] 从飞书消息触发 Claude Code 编码任务
- [ ] 任务完成后飞书自动通知

### Phase 4 验收
- [ ] 技能系统可加载和执行
- [ ] 流式卡片响应正常
- [ ] CLI 命令行可用

---

## 12. Claude Code CLI 通道

### 12.1 功能概述

在 Agent 层增加 **Claude Code CLI 通道**，作为 AI 推理的替代后端。通过 Claude Code CLI 子进程调用 AI，利用 Claude Max 订阅的 OAuth Token，无需额外 API 费用。

参考实现：`~/work/claude-api`

### 12.2 双后端架构

```
Agent 层
    │
    ├── AI Backend: API 模式（默认）
    │   └── @anthropic-ai/sdk → Anthropic API (API Key)
    │
    └── AI Backend: CLI 模式（新增）
        └── ClaudeSubprocess → claude CLI → OAuth Token (Keychain)
```

配置选择使用哪种后端：

```json
{
  "model": {
    "backend": "cli",          // "api" | "cli"
    "default": "claude-opus-4",
    
    // API 模式配置
    "apiKey": "sk-ant-xxx",
    "baseUrl": "https://api.anthropic.com",
    
    // CLI 模式配置（无需 apiKey）
    "cli": {
      "path": "claude",        // CLI 路径，默认从 PATH 查找
      "timeout": 120000        // 超时时间 ms
    }
  }
}
```

### 12.3 CLI 子进程管理（参考 claude-api）

```typescript
// src/ai/cli-backend.ts
class ClaudeCliBackend extends EventEmitter {
  
  // 调用 Claude Code CLI
  async *chat(prompt: string, options: CliOptions): AsyncIterable<ChatEvent> {
    const args = [
      '--print',                       // 非交互模式
      '--output-format', 'stream-json', // JSON 流输出
      '--verbose',
      '--include-partial-messages',     // 增量事件
      '--model', options.model || 'opus',
    ];
    
    if (options.sessionId) {
      args.push('--session-id', options.sessionId);
    } else {
      args.push('--no-session-persistence');
    }
    
    args.push(prompt);
    
    // 使用 spawn（非 exec），防止 shell 注入
    const child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    
    // 逐行解析 JSON 输出
    // 发射事件：content_delta / assistant / result
  }
}
```

### 12.4 CLI 输出事件类型

| `type` 值 | 含义 | 对应动作 |
|-----------|------|---------|
| `system` (subtype: init) | 会话初始化 | 记录 session info |
| `stream_event` (content_block_delta) | 流式增量文本 | 推送到卡片流式输出 |
| `assistant` | 完整回复 | 缓存完整响应 |
| `result` | 最终结果（含 token 用量） | 记录用量、结束会话 |

### 12.5 与现有架构集成

```typescript
// src/ai/client.ts - AI 客户端工厂
function createAiBackend(config: ModelConfig): AiBackend {
  if (config.backend === 'cli') {
    return new ClaudeCliBackend(config.cli);
  }
  return new AnthropicApiBackend(config);
}

// 统一接口
interface AiBackend {
  chat(messages: Message[], options?: ChatOptions): AsyncIterable<ChatEvent>;
  abort(): void;
}

// AI 推理事件类型
interface ChatEvent {
  type: 'text_delta' | 'tool_use' | 'tool_result' | 'done' | 'error';
  text?: string;           // type=text_delta 时的增量文本
  toolName?: string;       // type=tool_use 时的工具名
  toolInput?: unknown;     // type=tool_use 时的工具参数
  toolResult?: unknown;    // type=tool_result 时的工具执行结果
  usage?: { inputTokens: number; outputTokens: number };  // type=done 时的 token 用量
  error?: string;          // type=error 时的错误信息
}
```

### 12.6 优势

| 特性 | API 模式 | CLI 模式 |
|------|---------|---------|
| 计费 | 按量计费 (API Key) | 包月 (Claude Max $200/月) |
| 认证 | API Key | OAuth Token (Keychain) |
| 部署 | 需要 API Key | 需要 claude CLI 已登录 |
| 限制 | API 限流 | 订阅配额 |
| 适用 | 生产环境 | 个人开发/本地使用 |

### 12.7 开发计划补充

**Phase 1 补充**：
- [ ] CLI 子进程管理器（spawn、超时、JSON 行解析）
- [ ] AI Backend 抽象接口
- [ ] CLI 模式 + API 模式双后端
- [ ] 配置切换（`backend: "cli" | "api"`）

### 12.8 验收标准补充

- [ ] `backend: "cli"` 模式下，通过 Claude Code CLI 正常对话
- [ ] 流式输出正常（CLI JSON 流 → 飞书卡片流式）
- [ ] CLI 超时和异常处理
- [ ] CLI 和 API 模式可通过配置无缝切换

---

## 13. ACP — Agent Client Protocol

### 13.1 功能概述

ACP（Agent Client Protocol）是让外部 IDE/工具与 MyAgent 通信的协议。通过 ACP，可以：
- 让 Claude Code 直接作为编码 Agent 在后台运行
- 从终端 CLI 发起编码任务
- 在 IDE（如 Zed）中集成 Agent 能力

### 13.2 架构设计

```
                  ┌─────────────┐
                  │   飞书消息    │  ← Channel 层
                  └──────┬──────┘
                         │
                         ▼
                  ┌──────────────┐
                  │   Core 核心   │
                  │   消息路由     │
                  └──────┬──────┘
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
   ┌──────────┐   ┌──────────┐   ┌──────────┐
   │ AI 推理   │   │ ACP 层   │   │ 技能系统  │
   │ API/CLI  │   │ Agent 会话│   │ Skills   │
   └──────────┘   └──────────┘   └──────────┘
                        │
            ┌───────────┼───────────┐
            ▼           ▼           ▼
      ┌──────────┐ ┌──────────┐ ┌──────────┐
      │Claude Code│ │  Codex   │ │   Pi     │
      │  Agent   │ │  Agent   │ │  Agent   │
      └──────────┘ └──────────┘ └──────────┘
```

### 13.3 ACP 配置

```json
{
  "acp": {
    "enabled": true,
    "defaultAgent": "claude",
    "allowedAgents": ["claude", "codex", "pi"],
    "maxConcurrentSessions": 8,
    "sessionDefaults": {
      "timeout": 300000,
      "autoCleanup": true
    }
  }
}
```

### 13.4 核心接口

```typescript
// ACP Session 管理
interface AcpManager {
  // 创建 Agent 会话
  spawn(options: SpawnOptions): Promise<AcpSession>;
  
  // 列出活跃会话
  list(filter?: SessionFilter): AcpSession[];
  
  // 向会话发送消息
  send(sessionId: string, message: string): Promise<void>;
  
  // 控制会话
  steer(sessionId: string, instruction: string): Promise<void>;
  kill(sessionId: string): Promise<void>;
}

interface SpawnOptions {
  agentId: string;           // "claude" | "codex" | "pi"
  mode: "oneshot" | "session" | "persistent";
  cwd?: string;              // 工作目录
  thread?: boolean;          // 绑定到飞书消息线程
  prompt?: string;           // 初始任务描述
}

interface AcpSession {
  id: string;
  agentId: string;
  status: "running" | "idle" | "completed" | "failed";
  createdAt: number;
  lastActiveAt: number;
}
```

### 13.5 三种使用方式

#### 方式 1：从飞书聊天触发（推荐）

用户在飞书群/私聊中发消息，MyAgent 自动 spawn Claude Code 会话：

```
用户: "帮我在 ~/work/my-project 里修复那个登录 bug"
  ↓
MyAgent 核心收到消息
  ↓
识别为编码任务 → AcpManager.spawn({ agentId: "claude", cwd: "~/work/my-project" })
  ↓
Claude Code 后台执行
  ↓
完成后通过飞书回复结果
```

#### 方式 2：CLI 命令行

```bash
# 一次性任务
my-agent exec "帮我修复这个 bug" --cwd /path/to/repo

# 创建持久会话
my-agent session create --name my-coder --agent claude
my-agent session send my-coder "重构这个模块"

# 列出活跃会话
my-agent session list
```

#### 方式 3：IDE 集成（Phase 3+）

预留 JSON-RPC 或 HTTP 接口，供 IDE 插件调用 ACP 能力。

### 13.6 Claude Code Agent 实现

复用第 12 章的 `ClaudeCliBackend` 作为底层推理引擎，ACP Agent 层只负责会话生命周期管理：

```typescript
// src/acp/agents/claude-code.ts
class ClaudeCodeAgent implements AcpAgent {
  private backend: ClaudeCliBackend;  // 复用第12章

  async run(session: AcpSession, prompt: string): Promise<AcpResult> {
    // 复用 ClaudeCliBackend.chat()，指定 cwd
    const events = this.backend.chat(prompt, {
      model: this.config.model,
      sessionId: session.id,
      cwd: session.cwd,
    });
    
    // ACP 层职责：会话管理、飞书通知、超时控制
    for await (const event of events) {
      await this.notifyFeishu(session, event);
    }
  }
}
```

### 13.7 与飞书集成

ACP 会话的状态变化通过飞书消息通知：

| 事件 | 飞书通知 |
|------|---------|
| 会话创建 | "🚀 Claude Code 开始处理..." |
| 进度更新 | 卡片流式更新（可选） |
| 任务完成 | "✅ 任务完成！[查看变更]" |
| 任务失败 | "❌ 任务失败：[错误信息]" |

### 13.8 开发计划补充

**Phase 2 补充**：
- [ ] ACP Manager 核心实现
- [ ] Claude Code Agent 集成
- [ ] spawn / list / send / kill 基础操作
- [ ] 飞书消息触发 → ACP 会话

**Phase 3 补充**：
- [ ] CLI 命令行接口 (`my-agent exec / session`)
- [ ] 多 Agent 支持（Codex, Pi）
- [ ] IDE 集成接口（JSON-RPC）

### 13.9 验收标准补充

- [ ] 从飞书消息触发 Claude Code 编码任务
- [ ] Claude Code 后台执行并回报结果
- [ ] 支持 spawn / list / kill 会话管理
- [ ] 并发会话数量控制（maxConcurrentSessions）
- [ ] 任务超时自动清理

---

## 14. 错误处理与恢复

### 14.1 WebSocket 断连恢复

| 场景 | 处理策略 |
|------|---------|
| 网络闪断 | 自动重连，指数退避（1s → 2s → 4s → ... → 60s max） |
| 处理中的消息 | 记录到本地队列，重连后重新处理 |
| 飞书服务端断开 | 日志告警 + 自动重连 |
| 连续失败 >10 次 | 输出错误日志，等待 5min 后重试 |

### 14.2 Claude CLI 进程崩溃恢复

| 场景 | 处理策略 |
|------|---------|
| 进程异常退出 | 捕获 exit code，回复用户"处理失败，正在重试" |
| 超时（默认 120s） | kill 进程，回复用户"处理超时" |
| OOM | 检测退出码 137，限制并发进程数 |
| JSON 解析失败 | 跳过坏行，继续处理 |

### 14.3 JSONL 会话文件容错

- 每次写入后 fsync，防止断电丢失
- 读取时跳过解析失败的行（记录 warn 日志）
- 文件超过 10MB 自动归档（保留最近 200 条）

### 14.4 会话清理与归档策略

| 策略 | 规则 |
|------|------|
| 归档触发 | 文件 > 10MB 或消息数 > 500 条 |
| 归档方式 | gzip 压缩，移至 `~/.my-agent/sessions/archive/` |
| 归档命名 | `<sessionKey>.<timestamp>.jsonl.gz` |
| 保留策略 | 归档文件保留 30 天，超期自动删除 |
| 活跃文件 | 归档后仅保留最近 200 条消息 |

会话重置模式（`session.reset.kind`）：

| 模式 | 行为 |
|------|------|
| `daily` | 每天指定时间清空上下文（默认 04:00） |
| `manual` | 仅在用户主动要求时重置 |
| `never` | 永不自动重置，依赖归档策略管理 |

---

## 15. 安全设计

### 15.1 敏感配置环境变量注入

config.json 中的敏感字段支持环境变量引用：

```json
{
  "feishu": {
    "appId": "${FEISHU_APP_ID}",
    "appSecret": "${FEISHU_APP_SECRET}"
  },
  "model": {
    "apiKey": "${ANTHROPIC_API_KEY}"
  }
}
```

加载配置时自动替换 `${ENV_VAR}` 为对应环境变量值，未设置时报错启动失败。

### 15.2 ACP 安全限制

| 限制项 | 规则 |
|--------|------|
| cwd 白名单 | 只允许访问配置中指定的目录列表 |
| 并发限制 | maxConcurrentSessions 硬限制 |
| 超时清理 | 超时会话自动 kill |
| 命令注入防护 | 始终使用 `spawn()` 而非 `exec()` |

```json
{
  "acp": {
    "allowedPaths": ["~/work", "~/projects"],
    "maxConcurrentSessions": 8
  }
}
```

---

## 16. 日志与可观测性

### 16.1 日志设计

```typescript
// structured logging
interface LogEntry {
  timestamp: string;    // ISO 8601
  level: 'debug' | 'info' | 'warn' | 'error';
  module: string;       // 'feishu' | 'core' | 'ai' | 'acp'
  message: string;
  context?: Record<string, unknown>;
}
```

| 级别 | 输出位置 | 说明 |
|------|---------|------|
| debug | stdout（开发模式） | 详细调试信息 |
| info | stdout + 日志文件 | 正常操作记录 |
| warn | stdout + 日志文件 | 异常但可恢复 |
| error | stderr + 日志文件 | 需要关注的错误 |

日志文件路径：`~/.my-agent/logs/YYYY-MM-DD.log`

### 16.2 关键监控指标

| 指标 | 说明 |
|------|------|
| 消息延迟 | 从收到消息到首字节回复的时间 |
| AI 调用成功率 | API/CLI 调用成功/失败比例 |
| WebSocket 状态 | 连接/断开/重连次数 |
| 活跃会话数 | 当前处理中的会话数量 |
| **Token 消耗量** | 每次 AI 调用的 input/output token 数量，累计统计 |

---

## 变更历史

| 版本 | 日期 | 变更内容 |
|------|------|----------|
| v0.1 | 2026-03-14 | 初始版本 |
| v0.2 | 2026-03-14 | 完善 Channel 层、消息流程、会话管理 |
| v0.3 | 2026-03-14 | 新增 Claude Code CLI 通道（第12章） |
| v0.4 | 2026-03-14 | 新增 ACP — Agent Client Protocol（第13章） |
| v0.5 | 2026-03-14 | 错误处理、安全设计、日志可观测性（第14-16章）；防抖 800ms；Phase 1 扩至 2 周 |
| v0.6 | 2026-03-14 | 统一 ChatEvent 接口；Phase 重新划分为 4 阶段；会话清理策略；配置优先级说明；非功能性需求补充 |


### 16.3 Token 消耗量统计

#### 数据模型

```typescript
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;    // input + output
  estimatedCost: number;  // 按模型定价估算（美元）
}

interface TokenStats {
  // 当前会话
  session: TokenUsage;
  // 今日累计
  daily: TokenUsage & { date: string };
  // 按 Agent 统计
  byAgent: Record<string, TokenUsage>;
  // 按模型统计
  byModel: Record<string, TokenUsage>;
}
```

#### 采集方式

- **API 模式**：从 Anthropic API 响应的 `usage` 字段中获取 `input_tokens` 和 `output_tokens`
- **CLI 模式**：从 `claude --print --output-format stream-json` 的 `result` 事件中提取 `usage` 字段
- 每次 AI 调用完成后记录到 `ChatEvent.usage`，由会话管理层累加统计

#### 持久化

- 每日 Token 统计写入 `~/.my-agent/stats/token-usage-YYYY-MM-DD.json`

#### 查询接口

支持通过飞书消息查询 Token 用量：
- "今日 token 用量" → 返回当日统计
- "本周 token 用量" → 聚合近 7 天数据
- "token 报告" → 按 Agent/模型分维度汇总

#### 告警

| 条件 | 动作 |
|------|------|
| 单次调用 > 100k tokens | warn 日志 |
| 日消耗 > 配置阈值 (`tokenLimit.daily`) | 飞书通知用户 |
| 估算费用 > 预算上限 | 暂停 API 调用，切换 CLI 模式或提醒用户 |
