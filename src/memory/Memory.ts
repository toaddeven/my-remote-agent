// @ts-nocheck
// Memory 模块 - 短期记忆 + 长期记忆持久化
import { MemoryEntry, SearchResult, EmbeddingConfig } from '../types/index.js';
import { generateId, readJsonFile, writeJsonFile, logger, now } from '../utils/index.js';

export class Memory {
  private shortTermData: Map<string, any> = new Map();
  private longTermData: Map<string, any> = new Map();
  
  private storagePath: string;
  private shortTermLimit: number;
  private longTermThreshold: number;

  constructor(
    storagePath: string,
    shortTermLimit: number = 50,
    longTermThreshold: number = 30 * 60 * 1000
  ) {
    this.storagePath = storagePath;
    this.shortTermLimit = shortTermLimit;
    this.longTermThreshold = longTermThreshold;
  }

  // 初始化
  async init(): Promise<void> {
    await this.loadLongTerm();
    logger.info('Memory initialized');
  }

  // 存储短期记忆
  storeShortTerm(key: string, value: any): void {
    this.shortTermData.set(key, { value, timestamp: Date.now() });
    
    // 超过限制时移除最旧的
    if (this.shortTermData.size > this.shortTermLimit) {
      const firstKey = this.shortTermData.keys().next().value;
      if (firstKey) this.shortTermData.delete(firstKey);
    }
  }
  
  // 别名
  addShortTerm(key: string, value: any): void {
    this.storeShortTerm(key, value);
  }
  
  // 获取短期记忆
  retrieveShortTerm(key: string): any {
    return this.shortTermData.get(key)?.value;
  }
  
  // 删除短期记忆
  deleteShortTerm(key: string): void {
    this.shortTermData.delete(key);
  }
  
  // 获取最近的短期记忆
  getRecentShortTerm(limit: number = 10): Array<{ key: string; value: any; timestamp: number }> {
    return Array.from(this.shortTermData.entries())
      .slice(0, limit)
      .map(([key, data]) => ({ key, ...data }));
  }

  // 获取长期记忆数量
  getLongTermCount(): number {
    return this.longTermData.size;
  }

  // 存储长期记忆
  async storeLongTerm(key: string, value: any): Promise<void> {
    this.longTermData.set(key, { value, timestamp: Date.now() });
    logger.debug(`[Memory] 长期记忆已存储: key=${key}`);
    await this.saveLongTerm();
  }
  
  // 获取长期记忆
  async retrieveLongTerm(key: string): Promise<any> {
    return this.longTermData.get(key)?.value;
  }
  
  // 搜索长期记忆
  async searchLongTerm(query: string, topK: number = 5): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    
    for (const [key, data] of this.longTermData.entries()) {
      const content = JSON.stringify(data.value);
      if (content.toLowerCase().includes(query.toLowerCase())) {
        results.push({
          id: key,
          key,
          score: 1,
          metadata: { timestamp: data.timestamp },
        });
      }
    }
    
    return (results as any).slice(0, topK);
  }

  // 加载长期记忆
  private async loadLongTerm(): Promise<void> {
    try {
      const data = await readJsonFile(`${this.storagePath}/longterm.json`);
      if (data && typeof data === 'object') {
        for (const [key, value] of Object.entries(data as Record<string, any>)) {
          this.longTermData.set(key, value);
        }
      }
    } catch (e) {
      // 文件不存在，忽略
    }
  }

  // 保存长期记忆
  private async saveLongTerm(): Promise<void> {
    const data: Record<string, any> = {};
    for (const [key, value] of this.longTermData.entries()) {
      data[key] = value;
    }
    await writeJsonFile(`${this.storagePath}/longterm.json`, data);
    logger.debug(`[Memory] 长期记忆已持久化到磁盘 (${this.longTermData.size}条)`);
  }

  // 按前缀查询长期记忆
  getByPrefix(prefix: string): Array<{ key: string; value: any; timestamp: number }> {
    const results: Array<{ key: string; value: any; timestamp: number }> = [];
    for (const [key, data] of this.longTermData.entries()) {
      if (key.startsWith(prefix)) {
        results.push({ key, value: data.value, timestamp: data.timestamp });
      }
    }
    return results.sort((a, b) => a.timestamp - b.timestamp);
  }

  // 清理
  async cleanup(): Promise<void> {
    const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
    for (const [key, data] of this.longTermData.entries()) {
      if (data.timestamp < cutoff) {
        this.longTermData.delete(key);
      }
    }
    await this.saveLongTerm();
  }
}

export const memory = new Memory('./data/memory');
