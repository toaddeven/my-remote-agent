/**
 * 通用测试工具
 */
import { vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** 创建临时目录用于测试 */
export function createTempDir(prefix: string = 'myagent-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 清理临时目录 */
export function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 写入临时配置文件 */
export function writeTempConfig(dir: string, config: Record<string, unknown>): string {
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

/** 等待条件满足 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout: number = 5000,
  interval: number = 50,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor timed out after ${timeout}ms`);
}

/** 收集异步迭代器所有值 */
export async function collectAsyncIterator<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of iter) {
    results.push(item);
  }
  return results;
}

/** Mock console（捕获日志） */
export function mockConsole() {
  return {
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
  };
}

/** 创建最小有效配置 */
export function createMinimalConfig() {
  return {
    feishu: {
      appId: 'cli_test_app',
      appSecret: 'test_secret',
    },
    model: {
      default: 'anthropic/claude-opus-4-6',
      backend: 'api',
      apiKey: 'sk-ant-test',
    },
    agents: [
      {
        id: 'main',
        workspace: './workspace',
      },
    ],
    bindings: [
      {
        agentId: 'main',
        match: { channel: 'feishu', peer: { kind: 'direct' } },
      },
    ],
  };
}
