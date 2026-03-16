// @ts-nocheck
// GroupContextBuilder — 构建会话上下文（群聊 + 私聊）
// 近期消息直接注入，远期消息通过 QMD 语义检索或关键词匹配获取
import { Memory } from './Memory.js';
import { LLMClient } from '../llm/LLMClient.js';
import { QMDStore } from './QMDStore.js';
import { logger } from '../utils/index.js';

export interface GroupContextConfig {
  enabled: boolean;
  recentWindowMinutes: number;  // 近期窗口（分钟），默认 30
  recentMaxMessages: number;    // 近期最多条数，默认 20
  searchOlderMessages: boolean; // 是否检索更早消息
  searchTopK: number;           // 检索返回条数，默认 5
  compressOlderMessages: boolean; // 是否用 LLM 压缩远期消息
  compressThresholdMessages: number; // 超过 N 条触发压缩，默认 50
}

interface ConvRecord {
  key: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export class GroupContextBuilder {
  constructor(
    private memory: Memory,
    private llmClient: LLMClient,
    private config: GroupContextConfig,
    private qmdStore?: QMDStore,
  ) {}

  // 构建会话上下文，返回注入到 prompt 前的文本
  async buildContext(channelId: string, currentMessage: string): Promise<string> {
    if (!this.config.enabled) return '';

    const allRecords = this.getChannelRecords(channelId);
    if (allRecords.length === 0) return '';

    const now = Date.now();
    const recentCutoff = now - this.config.recentWindowMinutes * 60 * 1000;

    // 分割近期 vs 远期
    const recent: ConvRecord[] = [];
    const older: ConvRecord[] = [];
    for (const rec of allRecords) {
      if (rec.timestamp >= recentCutoff) {
        recent.push(rec);
      } else {
        older.push(rec);
      }
    }

    // 近期消息：取最新 N 条
    const recentSlice = recent.slice(-this.config.recentMaxMessages);

    logger.info(`[上下文] channel=${channelId}: 近期${recentSlice.length}条, 远期${older.length}条, QMD=${!!this.qmdStore}`);

    const parts: string[] = [];

    // 远期上下文（QMD 语义检索 / 压缩摘要 / 关键词检索）
    const olderContext = await this.buildOlderContext(channelId, older, currentMessage);
    if (olderContext) {
      parts.push(`[历史摘要]\n${olderContext}`);
    }

    // 近期消息直接列出
    if (recentSlice.length > 0) {
      const recentText = this.formatRecords(recentSlice);
      parts.push(`[近期历史消息 (最近${this.config.recentWindowMinutes}分钟)]\n${recentText}`);
    }

    if (parts.length === 0) return '';

    return `---\n以下是历史消息上下文，请结合这些信息回答：\n\n${parts.join('\n\n')}\n---\n\n`;
  }

  // 获取某 channel 所有对话记录
  private getChannelRecords(channelId: string): ConvRecord[] {
    const raw = this.memory.getByPrefix(`conv:${channelId}:`);
    return raw.map(item => {
      const parts = item.key.split(':');
      const role = parts[parts.length - 1] as 'user' | 'assistant';
      return {
        key: item.key,
        role,
        content: item.value?.content || String(item.value),
        timestamp: item.timestamp,
      };
    });
  }

  // 格式化消息列表
  private formatRecords(records: ConvRecord[]): string {
    return records.map(r => {
      const time = new Date(r.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      const label = r.role === 'user' ? '用户' : '助手';
      const content = r.content.length > 300 ? r.content.slice(0, 300) + '...' : r.content;
      return `[${time}] ${label}: ${content}`;
    }).join('\n');
  }

  // 构建远期上下文
  private async buildOlderContext(
    channelId: string,
    older: ConvRecord[],
    currentMessage: string,
  ): Promise<string> {
    if (older.length === 0 && !this.qmdStore) return '';

    // 优先使用已有的压缩摘要
    const cachedSummary = await this.getCachedSummary(channelId);
    if (cachedSummary) return cachedSummary;

    // 优先使用 QMD 语义检索
    if (this.qmdStore) {
      return this.searchByQMD(channelId, currentMessage);
    }

    if (older.length === 0) return '';

    // 如果超过阈值且启用压缩，用 LLM 压缩
    if (this.config.compressOlderMessages && older.length >= this.config.compressThresholdMessages) {
      return this.compressAndCache(channelId, older);
    }

    // 否则用关键词检索
    if (this.config.searchOlderMessages) {
      return this.searchOlder(older, currentMessage);
    }

    return '';
  }

  // QMD 混合语义检索
  private async searchByQMD(channelId: string, query: string): Promise<string> {
    try {
      const results = await this.qmdStore!.search(query, {
        channelId,
        topK: this.config.searchTopK,
      });

      logger.info(`[上下文] QMD 检索: ${results.length}条相关历史`);

      if (results.length === 0) return '';

      return results
        .sort((a, b) => a.timestamp - b.timestamp)
        .map(r => {
          const time = new Date(r.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
          const label = r.role === 'user' ? '用户' : '助手';
          const content = r.content.length > 300 ? r.content.slice(0, 300) + '...' : r.content;
          return `[${time}] ${label}: ${content}`;
        })
        .join('\n');
    } catch (err) {
      logger.error('[上下文] QMD 检索失败，回退关键词', err);
      return '';
    }
  }

  // 从缓存获取压缩摘要
  private async getCachedSummary(channelId: string): Promise<string | null> {
    const today = new Date().toISOString().slice(0, 10);
    const key = `conv-summary:${channelId}:${today}`;
    const cached = await this.memory.retrieveLongTerm(key);
    return cached || null;
  }

  // 用 LLM 压缩远期消息并缓存
  private async compressAndCache(channelId: string, records: ConvRecord[]): Promise<string> {
    const text = this.formatRecords(records);
    // 截断防止超长
    const truncated = text.length > 8000 ? text.slice(-8000) : text;

    try {
      const response = await this.llmClient.chat({
        messages: [{
          id: 'compress-req',
          role: 'user',
          content: `请将以下对话记录压缩为简洁的摘要，保留关键信息、决定和待办事项。用中文。\n\n${truncated}`,
          timestamp: Date.now(),
        }],
        maxTokens: 1000,
      });

      const summary = response.content;
      // 缓存到今天
      const today = new Date().toISOString().slice(0, 10);
      await this.memory.storeLongTerm(`conv-summary:${channelId}:${today}`, summary);
      logger.info(`会话摘要已压缩并缓存 (channel=${channelId}, 原始${records.length}条)`);
      return summary;
    } catch (error) {
      logger.error('LLM 压缩会话摘要失败', error);
      // 回退：返回最近几条远期消息
      return this.formatRecords(records.slice(-5));
    }
  }

  // 关键词检索远期消息
  private searchOlder(records: ConvRecord[], query: string): string {
    // 提取查询关键词（简单分词）
    const keywords = query
      .replace(/[^\u4e00-\u9fff\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2);

    if (keywords.length === 0) {
      // 无有效关键词，返回最近几条
      return this.formatRecords(records.slice(-this.config.searchTopK));
    }

    // 评分：每条消息匹配到的关键词数
    const scored = records.map(rec => {
      const lower = rec.content.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (lower.includes(kw.toLowerCase())) score++;
      }
      return { rec, score };
    });

    // 取匹配度最高的 topK
    const matched = scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score || b.rec.timestamp - a.rec.timestamp)
      .slice(0, this.config.searchTopK)
      .sort((a, b) => a.rec.timestamp - b.rec.timestamp); // 按时间排序输出

    if (matched.length === 0) return '';

    return this.formatRecords(matched.map(m => m.rec));
  }
}
