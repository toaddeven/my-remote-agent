# MyAgent 测试计划

> **版本**: v1.0
> **日期**: 2026-03-14
> **对应 PRD**: v0.6
> **框架**: Vitest
> **状态**: 初始版本

---

## 1. 测试策略

### 1.1 测试分层

| 层级 | 目录 | 说明 | 覆盖目标 |
|------|------|------|----------|
| L1 单元测试 | `tests/unit/` | 模块隔离测试，mock 外部依赖 | ≥ 80% |
| L2 集成测试 | `tests/integration/` | 模块间交互，mock 外部服务 | 核心流程 |
| L3 E2E 测试 | `tests/e2e/` | 完整流程，真实飞书 + AI | MVP 验收 |

### 1.2 测试框架

| 工具 | 用途 |
|------|------|
| Vitest | 测试运行器 + 断言库 |
| vitest mock | Mock/Stub/Spy |
| msw | HTTP 请求拦截（飞书 API） |

---

## 2. L1 单元测试

### 2.1 配置系统 (`src/core/config.ts`)

| 用例 ID | 场景 | 预期结果 |
|---------|------|----------|
| CFG-001 | 加载有效 config.json | 正确解析所有字段 |
| CFG-002 | config.json 不存在 | 使用默认值，不崩溃 |
| CFG-003 | JSON 格式错误 | 抛出明确错误 |
| CFG-004 | 缺少必填字段（feishu.appId） | 验证失败 |
| CFG-005 | 环境变量注入 `${FEISHU_APP_ID}` | 正确替换为环境变量值 |
| CFG-006 | 环境变量未设置 | 启动失败，明确报错 |
| CFG-007 | 模型配置优先级：agent > default > 内置 | 优先级正确 |
| CFG-008 | backend 字段 "api" / "cli" 切换 | 正确创建对应后端 |

### 2.2 Channel 接口 (`src/channels/types.ts`)

| 用例 ID | 场景 | 预期结果 |
|---------|------|----------|
| CHN-001 | Channel 接口契约验证 | 实现类必须有 connect/disconnect/sendMessage/onMessage |
| CHN-002 | InboundEvent 结构验证 | 包含 messageId, chatId, chatType, sender, content |
| CHN-003 | OutboundMessage 类型验证 | 支持 text/image/file/card |

### 2.3 飞书 Channel (`src/channels/feishu/`)

| 用例 ID | 场景 | 预期结果 |
|---------|------|----------|
| FSH-001 | WebSocket 连接成功 | isConnected() 返回 true |
| FSH-002 | WebSocket 连接失败（无凭证） | 抛出错误 |
| FSH-003 | 收到文本消息事件 | 正确解析为 InboundEvent |
| FSH-004 | 收到 @提及消息 | mentions 数组正确填充 |
| FSH-005 | 收到非 @提及群消息 | 根据配置决定是否处理 |
| FSH-006 | 发送文本消息 | 调用飞书 REST API，返回 message_id |
| FSH-007 | 发送卡片消息 | 正确构造卡片 JSON |
| FSH-008 | 更新卡片（流式） | 调用 patch API 更新卡片内容 |
| FSH-009 | WebSocket 断连后自动重连 | 指数退避（1s→2s→4s→...→60s） |
| FSH-010 | 连续失败 >10 次 | 等待 5min 后重试 |
| FSH-011 | ping/pong 心跳 | 30s 间隔发送 ping |
| FSH-012 | 消息去重（重复 message_id） | 第二次不触发 handler |

### 2.4 消息路由 (`src/core/router.ts`)

| 用例 ID | 场景 | 预期结果 |
|---------|------|----------|
| RTR-001 | 私聊消息路由到默认 Agent | 正确匹配 binding |
| RTR-002 | 群聊消息路由到指定 Agent | 按 chatId 匹配 |
| RTR-003 | 无匹配 binding | 路由到默认 Agent 或忽略 |
| RTR-004 | 通配符 binding（无 peer.id） | 匹配同 kind 所有对话 |

### 2.5 会话管理 (`src/core/session.ts`)

| 用例 ID | 场景 | 预期结果 |
|---------|------|----------|
| SES-001 | 创建私聊会话 | key 格式 `agent:<id>:feishu:dm:<userId>` |
| SES-002 | 创建群聊会话 | key 格式 `agent:<id>:feishu:group:<chatId>` |
| SES-003 | 会话隔离 | 不同 chatId 的消息不共享上下文 |
| SES-004 | 会话持久化写入 JSONL | 每条消息一行，JSON 格式 |
| SES-005 | 会话持久化读取 | 重启后恢复上下文 |
| SES-006 | JSONL 坏行跳过 | 解析失败的行跳过，warn 日志 |
| SES-007 | 文件 >10MB 自动归档 | gzip 压缩，保留最近 200 条 |
| SES-008 | daily 重置模式 | 04:00 清空上下文 |

### 2.6 消息排队 (`src/core/queue.ts`)

| 用例 ID | 场景 | 预期结果 |
|---------|------|----------|
| QUE-001 | followup 模式 | 新消息排队等待 |
| QUE-002 | steer 模式 | 新消息注入当前对话 |
| QUE-003 | interrupt 模式 | 中断当前，开始新处理 |
| QUE-004 | 防抖 800ms | 800ms 内连续消息合并 |
| QUE-005 | 并发限制 ≤10 | 超出排队 |

### 2.7 AI 后端 (`src/ai/`)

| 用例 ID | 场景 | 预期结果 |
|---------|------|----------|
| AI-001 | API 模式：正常对话 | 调用 Anthropic SDK，返回回复 |
| AI-002 | API 模式：流式输出 | 逐步产生 text_delta 事件 |
| AI-003 | API 模式：工具调用 | 返回 tool_use 事件 |
| AI-004 | API 模式：API 返回 429 | 限流重试 |
| AI-005 | API 模式：超时 | 返回 error 事件 |
| AI-006 | CLI 模式：正常对话 | spawn claude CLI，解析 JSON 流 |
| AI-007 | CLI 模式：流式输出 | content_block_delta → text_delta |
| AI-008 | CLI 模式：进程崩溃 | 捕获 exit code，返回错误 |
| AI-009 | CLI 模式：超时 120s | kill 进程 |
| AI-010 | CLI 模式：OOM (exit 137) | 检测并报告 |
| AI-011 | CLI 模式：JSON 解析失败 | 跳过坏行 |
| AI-012 | 后端工厂：config backend=api | 创建 AnthropicApiBackend |
| AI-013 | 后端工厂：config backend=cli | 创建 ClaudeCliBackend |
| AI-014 | ChatEvent 统一接口 | API/CLI 两种后端产生相同事件格式 |

### 2.8 ACP Manager (`src/acp/`)

| 用例 ID | 场景 | 预期结果 |
|---------|------|----------|
| ACP-001 | spawn 会话 | 创建 AcpSession，状态为 running |
| ACP-002 | list 活跃会话 | 返回正确列表 |
| ACP-003 | send 消息到会话 | 转发给底层 Agent |
| ACP-004 | kill 会话 | 进程终止，状态为 completed |
| ACP-005 | 并发限制 | 超过 maxConcurrentSessions 拒绝 |
| ACP-006 | 超时自动清理 | 超时会话自动 kill |
| ACP-007 | cwd 白名单验证 | 不在白名单的路径拒绝 |

---

## 3. L2 集成测试

### 3.1 飞书消息 → AI 回复

| 用例 ID | 场景 | 预期结果 |
|---------|------|----------|
| INT-001 | 私聊文本消息 → Claude 回复 | 完整链路通过 |
| INT-002 | 群聊 @提及 → Claude 回复 | 仅回复 @消息 |
| INT-003 | 多轮对话上下文保持 | 第二轮能引用第一轮内容 |
| INT-004 | 消息排队 followup | 前一条处理完再处理后一条 |

### 3.2 会话持久化

| 用例 ID | 场景 | 预期结果 |
|---------|------|----------|
| INT-005 | 对话 → 写入 JSONL → 重启 → 恢复 | 上下文正确恢复 |
| INT-006 | 归档触发 | 超过阈值后自动归档 |

### 3.3 ACP 集成

| 用例 ID | 场景 | 预期结果 |
|---------|------|----------|
| INT-007 | 飞书消息触发 → spawn Claude Code | 后台执行 + 飞书通知 |
| INT-008 | 任务完成通知 | 飞书收到完成消息 |

---

## 4. L3 E2E 测试

### 4.1 MVP 验收

| 用例 ID | 场景 | 验收标准 |
|---------|------|----------|
| E2E-001 | 飞书 WebSocket 长连接上线 | 连接成功，收到 ready |
| E2E-002 | 私聊消息收发 | 发消息 → 收到 AI 回复 |
| E2E-003 | 群聊 @提及回复 | @MyAgent → 仅回复该消息 |
| E2E-004 | 多轮对话 | 3 轮对话，上下文连贯 |
| E2E-005 | 配置切换模型 | 修改 config → 重启 → 使用新模型 |
| E2E-006 | CLI/API 双后端切换 | 切换 backend 配置，对话正常 |

### 4.2 WebSocket 稳定性

| 用例 ID | 场景 | 验收标准 |
|---------|------|----------|
| E2E-007 | 断线重连 | 断开 → 5s 内重连 → 消息不丢 |
| E2E-008 | 长时间运行 | 24h 无崩溃 |

---

## 5. 性能基线

| 指标 | 基线 | 测试方法 |
|------|------|----------|
| 首字节响应 | < 2s | 计时：消息发出 → 首个回复 |
| 启动时间 | < 3s | 计时：进程启动 → ready |
| 稳态内存 | < 200MB | 10 轮对话后 RSS |
| WebSocket 重连 | < 5s（正常网络） | 模拟断连 → 测量重连耗时 |

---

## 6. 测试基础设施

### 6.1 Mock 工厂

```
tests/utils/
├── mock-feishu.ts       # 模拟飞书 WebSocket + REST API
├── mock-ai-backend.ts   # 模拟 AI 后端（API/CLI）
├── mock-session.ts      # 模拟会话存储
└── helpers.ts           # 通用测试工具
```

### 6.2 测试配置

```
vitest.config.ts          # 单元测试配置
vitest.integration.config.ts  # 集成测试配置
```

---

## 7. 执行计划

| 阶段 | 测试范围 | 时间 |
|------|---------|------|
| Phase 1 开发中 | L1 单元测试 + L2 集成测试桩 | 与开发同步 |
| Phase 1 完成后 | L3 E2E MVP 验收 | 1-2 天 |
| Phase 2 开发中 | 补充排队/多 Agent/ACP 测试 | 与开发同步 |
| 每次发布前 | 全量回归 | CI |

---

## 8. 工程规范验收

| 用例 ID | 场景 | 验收标准 |
|---------|------|----------|
| ENG-001 | `node_modules/` 不在仓库中 | `.gitignore` 包含 `node_modules`，git 未跟踪该目录 |
| ENG-002 | README 包含依赖安装说明 | 有 `npm install` 步骤 + Node.js 版本要求 |
| ENG-003 | `package.json` 依赖声明完整 | 全新 `npm install && npm run build` 零错误 |
| ENG-004 | 敏感信息不硬编码 | 配置文件无明文 Secret/Key，使用 `${ENV_VAR}` 注入 |
| ENG-005 | 源码无 "openclaw" 字样 | `grep -ri openclaw src/` 零匹配 |
| ENG-006 | `node_modules/` 体积合理 | 生产依赖精简，无冗余大包 |
