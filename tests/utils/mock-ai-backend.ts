/**
 * AI Backend Mock 工厂
 * 模拟 Anthropic API 和 Claude CLI 后端
 */
import { vi } from 'vitest';

/** ChatEvent 统一接口（与 PRD 第12.5章一致） */
export interface ChatEvent {
  type: 'text_delta' | 'tool_use' | 'tool_result' | 'done' | 'error';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
}

/** 模拟 AI 后端接口 */
export interface MockAiBackend {
  chat: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
}

/** 创建 Mock API 后端 */
export function createMockApiBackend(responses?: ChatEvent[][]): MockAiBackend {
  const defaultResponse: ChatEvent[] = [
    { type: 'text_delta', text: '你好' },
    { type: 'text_delta', text: '！我是 MyAgent。' },
    { type: 'done', usage: { inputTokens: 100, outputTokens: 50 } },
  ];

  let callIndex = 0;
  const responseQueue = responses || [defaultResponse];

  return {
    chat: vi.fn().mockImplementation(async function* () {
      const events = responseQueue[callIndex % responseQueue.length];
      callIndex++;
      for (const event of events) {
        yield event;
      }
    }),
    abort: vi.fn(),
  };
}

/** 创建 Mock CLI 后端 */
export function createMockCliBackend(responses?: ChatEvent[][]): MockAiBackend {
  return createMockApiBackend(responses); // 统一接口，行为相同
}

/** 创建模拟工具调用响应 */
export function createToolCallResponse(toolName: string, input: unknown, result: unknown): ChatEvent[] {
  return [
    { type: 'tool_use', toolName, toolInput: input },
    { type: 'tool_result', toolName, toolResult: result },
    { type: 'text_delta', text: `已执行 ${toolName}` },
    { type: 'done', usage: { inputTokens: 200, outputTokens: 100 } },
  ];
}

/** 创建模拟错误响应 */
export function createErrorResponse(error: string): ChatEvent[] {
  return [{ type: 'error', error }];
}

/** 创建模拟超时响应（永远不完成） */
export function createHangingBackend(): MockAiBackend {
  return {
    chat: vi.fn().mockImplementation(async function* () {
      await new Promise(() => {}); // never resolves
    }),
    abort: vi.fn(),
  };
}
