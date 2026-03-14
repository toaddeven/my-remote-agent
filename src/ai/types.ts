/**
 * AI Backend abstraction types
 *
 * Defines the unified interface for AI backends (API and CLI modes).
 */

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model?: string;
  systemPrompt?: string;
  maxTokens?: number;
  sessionId?: string;
  cwd?: string;
  timeout?: number;
}

export interface ChatEvent {
  type: 'text_delta' | 'tool_use' | 'tool_result' | 'done' | 'error';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
}

export interface AiBackend {
  chat(messages: Message[], options?: ChatOptions): AsyncIterable<ChatEvent>;
  abort(): void;
}
