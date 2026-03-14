/**
 * 卡片消息单元测试
 * 对应 TEST_PLAN: FSH-007 ~ FSH-008
 */
import { describe, it, expect } from 'vitest';
import { buildTextCard, buildStreamingCard } from '../../../../src/channels/feishu/card.js';

describe('Card Builder', () => {
  // FSH-007: 构造卡片 JSON
  it('should build text card with body content', () => {
    const card = buildTextCard('Hello World') as Record<string, unknown>;

    expect(card).toHaveProperty('schema', '2.0');
    expect(card).toHaveProperty('body');

    const body = card['body'] as { elements: Array<Record<string, unknown>> };
    expect(body.elements).toHaveLength(1);
    expect(body.elements[0]).toHaveProperty('tag', 'div');
  });

  it('should build text card with title', () => {
    const card = buildTextCard('Content', 'My Title') as Record<string, unknown>;

    expect(card).toHaveProperty('header');
    const header = card['header'] as { title: { content: string; tag: string } };
    expect(header.title.content).toBe('My Title');
    expect(header.title.tag).toBe('plain_text');
  });

  it('should build text card without title when not provided', () => {
    const card = buildTextCard('No title') as Record<string, unknown>;
    expect(card).not.toHaveProperty('header');
  });

  // FSH-008: 流式卡片
  it('should show cursor when streaming is not done', () => {
    const card = buildStreamingCard('Processing...', false) as Record<string, unknown>;
    const body = card['body'] as { elements: Array<Record<string, unknown>> };

    // 应有 2 个元素：内容 + "正在思考中..."
    expect(body.elements).toHaveLength(2);

    // 内容应包含光标 ▍
    const textEl = body.elements[0] as { text: { content: string } };
    expect(textEl.text.content).toContain('▍');

    // 第二个元素应是"正在思考中..."
    const thinkingEl = body.elements[1] as { text: { content: string } };
    expect(thinkingEl.text.content).toContain('正在思考中');
  });

  it('should not show cursor or thinking text when done', () => {
    const card = buildStreamingCard('Final result', true) as Record<string, unknown>;
    const body = card['body'] as { elements: Array<Record<string, unknown>> };

    expect(body.elements).toHaveLength(1);

    const textEl = body.elements[0] as { text: { content: string } };
    expect(textEl.text.content).not.toContain('▍');
    expect(textEl.text.content).toBe('Final result');
  });

  it('should handle empty text in streaming card', () => {
    const card = buildStreamingCard('', false) as Record<string, unknown>;
    const body = card['body'] as { elements: Array<Record<string, unknown>> };

    const textEl = body.elements[0] as { text: { content: string } };
    expect(textEl.text.content).toBe(' ▍');
  });
});
