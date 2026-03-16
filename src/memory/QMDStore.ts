// @ts-nocheck
// QMDStore — QMD SDK 封装，提供消息索引和混合检索接口
import { createStore } from '@tobilu/qmd';
import { logger } from '../utils/index.js';

export interface QMDConfig {
  enabled: boolean;
  dbPath?: string;           // QMD 数据目录，默认 ./data/qmd
  collectionName?: string;   // collection 名，默认 'work-agent-conv'
  minScore?: number;         // 检索最低分，默认 0.25
}

export interface QMDSearchResult {
  content: string;
  channelId: string;
  role: 'user' | 'assistant';
  timestamp: number;
  score: number;
}

export class QMDStore {
  private store: any = null;
  private config: QMDConfig;
  private dbPath: string;
  private collectionName: string;

  constructor(config: QMDConfig) {
    this.config = config;
    this.dbPath = config.dbPath || './data/qmd';
    this.collectionName = config.collectionName || 'work-agent-conv';
  }

  async init(): Promise<void> {
    const fs = await import('fs/promises');
    await fs.mkdir(this.dbPath, { recursive: true });

    this.store = await createStore({
      path: this.dbPath,
      collection: this.collectionName,
    });

    logger.info(`[QMD] 已初始化 (path=${this.dbPath}, collection=${this.collectionName})`);
  }

  // 将消息写入 QMD collection
  async indexMessage(params: {
    channelId: string;
    content: string;
    role: 'user' | 'assistant';
    timestamp: number;
  }): Promise<void> {
    if (!this.store) return;

    const { channelId, content, role, timestamp } = params;
    const docId = `${channelId}-${timestamp}-${role}`;

    // 构建 markdown 文档（QMD 自动做 chunking + embedding）
    const markdown = [
      '---',
      `channelId: ${channelId}`,
      `role: ${role}`,
      `timestamp: ${timestamp}`,
      '---',
      content,
    ].join('\n');

    await this.store.add({
      id: docId,
      content: markdown,
      metadata: { channelId, role, timestamp },
    });

    logger.info(`[QMD] 消息已索引 (channel=${channelId}, role=${role})`);
  }

  // 混合检索（BM25 + 向量 + 重排序）
  async search(query: string, options?: {
    channelId?: string;
    topK?: number;
    minScore?: number;
  }): Promise<QMDSearchResult[]> {
    if (!this.store) return [];

    const topK = options?.topK || 5;
    const minScore = options?.minScore ?? this.config.minScore ?? 0.25;

    const filter = options?.channelId
      ? { channelId: options.channelId }
      : undefined;

    const results = await this.store.search({
      query,
      limit: topK,
      filter,
    });

    const mapped: QMDSearchResult[] = (results || [])
      .filter((r: any) => (r.score ?? 1) >= minScore)
      .map((r: any) => ({
        content: this.extractContent(r.content || r.document || ''),
        channelId: r.metadata?.channelId || '',
        role: r.metadata?.role || 'user',
        timestamp: r.metadata?.timestamp || 0,
        score: r.score ?? 1,
      }));

    logger.info(`[QMD] 检索完成 (query=${query.substring(0, 30)}..., 结果=${mapped.length}条, topScore=${mapped[0]?.score || 0})`);
    return mapped;
  }

  // 从 markdown 文档中提取正文（去掉 frontmatter）
  private extractContent(doc: string): string {
    const fmEnd = doc.indexOf('---', doc.indexOf('---') + 3);
    if (fmEnd !== -1) {
      return doc.substring(fmEnd + 3).trim();
    }
    return doc.trim();
  }

  async close(): Promise<void> {
    if (this.store?.close) {
      await this.store.close();
    }
    this.store = null;
    logger.info('[QMD] 已关闭');
  }
}
