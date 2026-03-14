/**
 * 配置系统集成测试 - 测试真实的 loadConfig 函数
 * 对应 TEST_PLAN: CFG-001 ~ CFG-008
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { createTempDir, cleanupTempDir, writeTempConfig, createMinimalConfig } from '../../utils/helpers.js';
import { loadConfig, resolveEnvVars } from '../../../src/core/config.js';

describe('loadConfig() - Real Implementation', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  // CFG-001: 加载有效配置
  it('should load valid config with all required fields', () => {
    const configPath = writeTempConfig(tempDir, createMinimalConfig());
    const config = loadConfig(configPath);

    expect(config.feishu.appId).toBe('cli_test_app');
    expect(config.model.default).toBe('anthropic/claude-opus-4-6');
    expect(config.agents).toHaveLength(1);
    expect(config.bindings).toHaveLength(1);
  });

  // CFG-003: JSON 格式错误
  it('should throw on malformed JSON', () => {
    const configPath = `${tempDir}/config.json`;
    fs.writeFileSync(configPath, '{ broken json!!!');

    expect(() => loadConfig(configPath)).toThrow(/Failed to parse/);
  });

  // CFG-002: 文件不存在
  it('should throw when config file does not exist', () => {
    expect(() => loadConfig('/nonexistent/config.json')).toThrow(/Failed to read/);
  });

  // CFG-004: 缺少 feishu
  it('should throw when feishu config is missing', () => {
    const configPath = writeTempConfig(tempDir, {
      model: { default: 'claude' },
      agents: [{ id: 'main' }],
      bindings: [{ agentId: 'main', match: { channel: 'feishu' } }],
    });

    expect(() => loadConfig(configPath)).toThrow(/feishu/);
  });

  // CFG-004: 缺少 feishu.appId
  it('should throw when feishu.appId is missing', () => {
    const configPath = writeTempConfig(tempDir, {
      feishu: { appSecret: 'secret' },
      model: { default: 'claude' },
      agents: [{ id: 'main' }],
      bindings: [{ agentId: 'main', match: { channel: 'feishu' } }],
    });

    expect(() => loadConfig(configPath)).toThrow(/appId/);
  });

  // CFG-004: 缺少 agents
  it('should throw when agents array is empty', () => {
    const configPath = writeTempConfig(tempDir, {
      feishu: { appId: 'test', appSecret: 'secret' },
      model: { default: 'claude' },
      agents: [],
      bindings: [{ agentId: 'main', match: { channel: 'feishu' } }],
    });

    expect(() => loadConfig(configPath)).toThrow(/agent/);
  });

  // CFG-005: 环境变量注入
  it('should resolve environment variables in config', () => {
    process.env['TEST_APP_ID'] = 'resolved_app_id';
    process.env['TEST_SECRET'] = 'resolved_secret';

    try {
      const configPath = writeTempConfig(tempDir, {
        feishu: { appId: '${TEST_APP_ID}', appSecret: '${TEST_SECRET}' },
        model: { default: 'claude', backend: 'api', apiKey: 'direct-key' },
        agents: [{ id: 'main' }],
        bindings: [{ agentId: 'main', match: { channel: 'feishu', peer: { kind: 'direct' } } }],
      });

      const config = loadConfig(configPath);
      expect(config.feishu.appId).toBe('resolved_app_id');
      expect(config.feishu.appSecret).toBe('resolved_secret');
    } finally {
      delete process.env['TEST_APP_ID'];
      delete process.env['TEST_SECRET'];
    }
  });
});

describe('resolveEnvVars()', () => {
  it('should replace ${VAR} with env value', () => {
    process.env['MY_VAR'] = 'hello';
    try {
      expect(resolveEnvVars('${MY_VAR}')).toBe('hello');
    } finally {
      delete process.env['MY_VAR'];
    }
  });

  it('should return empty string for unset env var', () => {
    delete process.env['UNSET_VAR'];
    expect(resolveEnvVars('${UNSET_VAR}')).toBe('');
  });

  it('should handle string without env vars', () => {
    expect(resolveEnvVars('plain string')).toBe('plain string');
  });

  it('should handle multiple env vars in one string', () => {
    process.env['A'] = 'hello';
    process.env['B'] = 'world';
    try {
      expect(resolveEnvVars('${A} ${B}')).toBe('hello world');
    } finally {
      delete process.env['A'];
      delete process.env['B'];
    }
  });
});
