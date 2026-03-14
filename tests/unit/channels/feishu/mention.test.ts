/**
 * @提及处理单元测试
 * 对应 TEST_PLAN: CHN-001 ~ CHN-003, FSH-004
 */
import { describe, it, expect } from 'vitest';
import { extractMentions, isBotMentioned, stripMentions } from '../../../../src/channels/feishu/mention.js';

describe('Mention Extraction', () => {
  it('should extract open_id from mentions array', () => {
    const mentions = [
      { key: '@_user_1', id: { open_id: 'ou_bot_001' }, name: 'MyAgent' },
      { key: '@_user_2', id: { open_id: 'ou_user_002' }, name: 'User2' },
    ];

    const result = extractMentions(mentions);
    expect(result).toEqual(['ou_bot_001', 'ou_user_002']);
  });

  it('should fallback to user_id when open_id is missing', () => {
    const mentions = [
      { key: '@_user_1', id: { user_id: 'uid_001' }, name: 'User' },
    ];

    const result = extractMentions(mentions);
    expect(result).toEqual(['uid_001']);
  });

  it('should return empty array for null/undefined input', () => {
    expect(extractMentions(null)).toEqual([]);
    expect(extractMentions(undefined)).toEqual([]);
    expect(extractMentions('not array')).toEqual([]);
  });

  it('should skip mentions without id', () => {
    const mentions = [
      { key: '@_user_1', name: 'NoId' },
      { key: '@_user_2', id: { open_id: 'ou_valid' }, name: 'Valid' },
    ];

    const result = extractMentions(mentions);
    expect(result).toEqual(['ou_valid']);
  });

  it('should handle empty mentions array', () => {
    expect(extractMentions([])).toEqual([]);
  });
});

describe('Bot Mention Detection', () => {
  it('should detect bot is mentioned', () => {
    expect(isBotMentioned(['ou_bot_001', 'ou_user_002'], 'ou_bot_001')).toBe(true);
  });

  it('should return false when bot is not mentioned', () => {
    expect(isBotMentioned(['ou_user_001', 'ou_user_002'], 'ou_bot_001')).toBe(false);
  });

  it('should return false for empty mentions', () => {
    expect(isBotMentioned([], 'ou_bot_001')).toBe(false);
  });
});

describe('Mention Stripping', () => {
  it('should strip @_user_ patterns', () => {
    expect(stripMentions('@_user_123 hello world')).toBe('hello world');
  });

  it('should strip multiple mentions', () => {
    expect(stripMentions('@_user_1 @_user_2 hello')).toBe('hello');
  });

  it('should handle text without mentions', () => {
    expect(stripMentions('hello world')).toBe('hello world');
  });

  it('should handle empty string', () => {
    expect(stripMentions('')).toBe('');
  });

  it('should strip @name style mentions', () => {
    expect(stripMentions('@MyAgent 帮我查一下')).toBe('帮我查一下');
  });
});
