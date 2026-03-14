# MyAgent

轻量级个人 AI 助理，通过飞书 WebSocket 长连接通信，使用 Claude 作为 AI 引擎。

## 环境要求

- Node.js ≥ 22
- npm
- 飞书企业自建应用（需开通机器人能力 + WebSocket 长连接）
- Claude CLI 或 Anthropic API Key（二选一）

## 快速开始

### 1. 安装依赖

> **注意**：`node_modules/` 不随项目分发，需在部署环境中自行安装。

```bash
cd ~/.openclaw/workspace/my-agent
npm install

**生产依赖**：
- `@larksuiteoapi/node-sdk` — 飞书 SDK（WebSocket 长连接）
- `@anthropic-ai/sdk` — Anthropic API SDK
- `zod` — 配置校验

**开发依赖**：
- `typescript` — 编译器
- `vitest` — 测试框架
- `@types/node` — Node.js 类型定义```

### 2. 配置飞书应用

1. 前往 [飞书开放平台](https://open.feishu.cn/) 创建企业自建应用
2. 开启「机器人」能力
3. 开启「使用长连接接收事件」
4. 添加权限：`im:message`、`im:message.group_at_msg`、`im:chat`
5. 发布应用并获取 App ID 和 App Secret

### 3. 配置环境变量

```bash
export FEISHU_APP_ID="cli_xxxx"
export FEISHU_APP_SECRET="xxxx"
export ANTHROPIC_API_KEY="sk-ant-xxxx"  # 使用 API 模式时需要
```

### 4. 创建配置文件

在项目根目录创建 `config.json`：

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
    },
    {
      "agentId": "main",
      "match": { "channel": "feishu", "peer": { "kind": "group" } }
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

**配置说明**：
- `${ENV_VAR}` 语法会在启动时自动替换为环境变量值
- `model.backend`：`"api"` 使用 Anthropic API，`"cli"` 使用本地 Claude CLI
- `bindings`：路由规则，将消息匹配到对应 Agent
- `session.reset.kind`：`"daily"` 每天凌晨重置会话，`"manual"` 手动重置，`"never"` 永不重置
- `messages.queue.mode`：`"followup"` 排队等待，`"steer"` 打断当前任务，`"interrupt"` 立即打断

**配置优先级**：`agents[].model` > `model.default` > 内置默认值

### 5. 编译和运行

```bash
# 编译
npm run build

# 运行
npm start

# 开发模式（热重载）
npm run dev
```

### 6. 验证

在飞书中找到你的机器人，发送一条消息，查看终端日志是否收到消息。

## AI 后端模式

### API 模式

使用 Anthropic 官方 API，需要 API Key：

```json
{
  "model": {
    "backend": "api",
    "default": "claude-sonnet-4-20250514",
    "apiKey": "${ANTHROPIC_API_KEY}"
  }
}
```

### CLI 模式（推荐）

使用本地安装的 Claude CLI，利用 Claude Max 订阅的 OAuth Token，无需 API Key：

```json
{
  "model": {
    "backend": "cli",
    "default": "anthropic/claude-opus-4-6",
    "cli": {
      "path": "claude",
      "timeout": 120000
    }
  }
}
```

需要先安装并登录 Claude CLI：
```bash
npm install -g @anthropic-ai/claude-code
claude login
```

## 测试

```bash
# 运行所有单元测试
npm test

# 监听模式
npm run test:watch

# 集成测试
npm run test:integration
```

## 项目结构

```
my-agent/
├── src/
│   ├── index.ts              # 入口
│   ├── core/                 # 核心层
│   │   ├── app.ts            # 应用主类
│   │   ├── config.ts         # 配置加载（支持 ${ENV_VAR}）
│   │   ├── router.ts         # 消息路由（去重、防抖）
│   │   ├── session.ts        # 会话管理（JSONL 持久化）
│   │   └── queue.ts          # 消息排队
│   ├── channels/             # 渠道层
│   │   ├── types.ts          # Channel 接口
│   │   └── feishu/           # 飞书实现
│   │       ├── channel.ts    # WebSocket 长连接
│   │       ├── events.ts     # 事件解析
│   │       ├── send.ts       # 消息发送
│   │       ├── mention.ts    # @提及处理
│   │       └── card.ts       # 卡片消息
│   ├── ai/                   # AI 引擎
│   │   ├── types.ts          # AiBackend 接口
│   │   ├── api-backend.ts    # Anthropic API
│   │   ├── cli-backend.ts    # Claude CLI
│   │   └── factory.ts        # 工厂方法
│   ├── agents/               # Agent 管理
│   ├── acp/                  # Agent Client Protocol
│   ├── skills/               # 技能系统
│   └── utils/                # 工具（日志等）
├── tests/                    # 测试用例
├── config.json               # 配置文件（需自行创建）
├── PRD.md                    # 产品需求文档
└── CLAUDE.md                 # Claude Code 开发指南
```

## 常见问题

**Q: 飞书连接失败？**
- 检查 App ID 和 App Secret 是否正确
- 确认应用已开启「使用长连接接收事件」
- 确认应用已发布上线

**Q: Claude CLI 调用超时？**
- 检查 `claude` 命令是否在 PATH 中
- 运行 `claude --version` 确认已安装
- 增大 `cli.timeout` 配置值

**Q: 环境变量未生效？**
- 确认变量已 export（`echo $FEISHU_APP_ID`）
- config.json 中使用 `${VAR_NAME}` 格式（注意大括号）

## 相关文档

- [PRD.md](./PRD.md) — 产品需求文档
- [CLAUDE.md](./CLAUDE.md) — 开发指南
- [TEST_PLAN.md](./TEST_PLAN.md) — 测试方案
