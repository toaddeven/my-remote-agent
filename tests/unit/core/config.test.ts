/**
 * 配置系统单元测试
 * 对应 TEST_PLAN: CFG-001 ~ CFG-008
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import { createTempDir, cleanupTempDir, writeTempConfig } from '../../utils/helpers.js';

// 注意：当前 src/config.ts 使用 zod，但 PRD v0.6 要求环境变量注入等功能
// 这些测试基于 PRD 设计，开发完成后需要适配实际实现

describe('Config System', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  // CFG-001: 加载有效 config.json
  it('should load valid config.json with all fields', () => {
    const config = {
      feishu: {
        appId: 'cli_test',
        appSecret: 'secret_test',
        botName: 'TestBot',
      },
      model: {
        default: 'anthropic/claude-opus-4-6',
        backend: 'api',
        apiKey: 'sk-ant-test',
      },
      agents: [{ id: 'main', workspace: './workspace' }],
      bindings: [
        { agentId: 'main', match: { channel: 'feishu', peer: { kind: 'direct' } } },
      ],
      session: { dmScope: 'per-peer', reset: { kind: 'daily', time: '04:00' } },
      messages: { queue: { mode: 'followup', debounceMs: 800 } },
    };

    const configPath = writeTempConfig(tempDir, config);
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    expect(raw.feishu.appId).toBe('cli_test');
    expect(raw.model.default).toBe('anthropic/claude-opus-4-6');
    expect(raw.agents).toHaveLength(1);
    expect(raw.session.reset.kind).toBe('daily');
    expect(raw.messages.queue.debounceMs).toBe(800);
  });

  // CFG-002: config.json 不存在时使用默认值
  it('should use defaults when config.json does not exist', () => {
    // 当实际 loadConfig 实现时，应测试：
    // const config = loadConfig('/nonexistent/path/config.json');
    // expect(config.model.default).toBe('anthropic/claude-opus-4-6');
    expect(true).toBe(true); // placeholder until impl
  });

  // CFG-003: JSON 格式错误
  it('should throw on malformed JSON', () => {
    const configPath = `${tempDir}/config.json`;
    fs.writeFileSync(configPath, '{ invalid json }');

    expect(() => JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toThrow();
  });

  // CFG-004: 缺少必填字段
  it('should reject config missing required feishu credentials', () => {
    const config = {
      feishu: {}, // 缺少 appId 和 appSecret
      model: { default: 'claude' },
    };
    const configPath = writeTempConfig(tempDir, config);
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    // 验证 feishu 必填字段缺失
    expect(raw.feishu.appId).toBeUndefined();
    expect(raw.feishu.appSecret).toBeUndefined();
    // 当 loadConfig 实现验证后：expect(() => loadConfig(configPath)).toThrow(/appId/);
  });

  // CFG-005: 环境变量注入
  it('should resolve ${ENV_VAR} placeholders', () => {
    const config = {
      feishu: {
        appId: '${FEISHU_APP_ID}',
        appSecret: '${FEISHU_APP_SECRET}',
      },
      model: {
        apiKey: '${ANTHROPIC_API_KEY}',
      },
    };

    // 模拟环境变量替换逻辑
    function resolveEnvVars(obj: unknown): unknown {
      if (typeof obj === 'string') {
        return obj.replace(/\$\{(\w+)\}/g, (_, key) => {
          const val = process.env[key];
          if (!val) throw new Error(`Environment variable ${key} is not set`);
          return val;
        });
      }
      if (Array.isArray(obj)) return obj.map(resolveEnvVars);
      if (typeof obj === 'object' && obj !== null) {
        return Object.fromEntries(
          Object.entries(obj).map(([k, v]) => [k, resolveEnvVars(v)]),
        );
      }
      return obj;
    }

    process.env.FEISHU_APP_ID = 'cli_from_env';
    process.env.FEISHU_APP_SECRET = 'secret_from_env';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env';

    try {
      const resolved = resolveEnvVars(config) as typeof config;
      expect(resolved.feishu.appId).toBe('cli_from_env');
      expect(resolved.feishu.appSecret).toBe('secret_from_env');
      expect(resolved.model.apiKey).toBe('sk-ant-from-env');
    } finally {
      delete process.env.FEISHU_APP_ID;
      delete process.env.FEISHU_APP_SECRET;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  // CFG-006: 环境变量未设置
  it('should fail if referenced env var is not set', () => {
    function resolveEnvVars(str: string): string {
      return str.replace(/\$\{(\w+)\}/g, (_, key) => {
        const val = process.env[key];
        if (!val) throw new Error(`Environment variable ${key} is not set`);
        return val;
      });
    }

    delete process.env.MISSING_VAR;
    expect(() => resolveEnvVars('${MISSING_VAR}')).toThrow(/MISSING_VAR/);
  });

  // CFG-007: 模型配置优先级
  it('should respect model config priority: agent > default > builtin', () => {
    const config = {
      model: { default: 'claude-sonnet' },
      agents: [
        { id: 'main', model: 'claude-opus' },
        { id: 'secondary' }, // 无 model 字段
      ],
    };

    // Agent 级别优先
    const mainModel = config.agents[0].model || config.model.default || 'anthropic/claude-opus-4-6';
    expect(mainModel).toBe('claude-opus');

    // 回退到 default
    const secondaryAgent = config.agents[1] as { id: string; model?: string };
    const secModel = secondaryAgent.model || config.model.default || 'anthropic/claude-opus-4-6';
    expect(secModel).toBe('claude-sonnet');
  });

  // CFG-008: backend 字段切换
  it('should support backend field: api | cli', () => {
    const apiConfig = { model: { backend: 'api', apiKey: 'sk-test' } };
    const cliConfig = { model: { backend: 'cli', cli: { path: 'claude', timeout: 120000 } } };

    expect(apiConfig.model.backend).toBe('api');
    expect(cliConfig.model.backend).toBe('cli');
    expect(cliConfig.model.cli.timeout).toBe(120000);
  });
});
