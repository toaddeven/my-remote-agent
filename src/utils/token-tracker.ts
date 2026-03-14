/**
 * Token consumption tracker.
 *
 * Tracks per-session and daily token usage, persists to JSON files.
 * Path: ~/.my-agent/stats/token-usage-YYYY-MM-DD.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createLogger } from './logger.js';

const logger = createLogger('token-tracker');

/** Single token record */
export interface TokenRecord {
  timestamp: number;
  sessionKey: string;
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** Daily aggregated stats */
export interface DailyStats {
  date: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRequests: number;
  byAgent: Record<string, { inputTokens: number; outputTokens: number; requests: number }>;
  byModel: Record<string, { inputTokens: number; outputTokens: number; requests: number }>;
  records: TokenRecord[];
}

/** Alert threshold */
const SINGLE_REQUEST_ALERT_TOKENS = 100_000;

export class TokenTracker {
  private readonly statsDir: string;
  private todayStats: DailyStats | null = null;
  private todayDate: string = '';

  constructor(statsDir?: string) {
    this.statsDir = statsDir ?? join(homedir(), '.my-agent', 'stats');
    mkdirSync(this.statsDir, { recursive: true });
  }

  /**
   * Record a token usage event.
   * Returns true if a high-usage alert should be triggered.
   */
  record(
    sessionKey: string,
    agentId: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
  ): boolean {
    const now = Date.now();
    const dateStr = this.formatDate(now);
    const stats = this.getOrLoadDay(dateStr);

    const record: TokenRecord = {
      timestamp: now,
      sessionKey,
      agentId,
      model,
      inputTokens,
      outputTokens,
    };

    stats.records.push(record);
    stats.totalInputTokens += inputTokens;
    stats.totalOutputTokens += outputTokens;
    stats.totalRequests += 1;

    // By agent
    if (!stats.byAgent[agentId]) {
      stats.byAgent[agentId] = { inputTokens: 0, outputTokens: 0, requests: 0 };
    }
    stats.byAgent[agentId]!.inputTokens += inputTokens;
    stats.byAgent[agentId]!.outputTokens += outputTokens;
    stats.byAgent[agentId]!.requests += 1;

    // By model
    if (!stats.byModel[model]) {
      stats.byModel[model] = { inputTokens: 0, outputTokens: 0, requests: 0 };
    }
    stats.byModel[model]!.inputTokens += inputTokens;
    stats.byModel[model]!.outputTokens += outputTokens;
    stats.byModel[model]!.requests += 1;

    // Persist
    this.saveDay(dateStr, stats);

    // Check alert
    const totalThisRequest = inputTokens + outputTokens;
    if (totalThisRequest > SINGLE_REQUEST_ALERT_TOKENS) {
      logger.warn(`High token usage: ${totalThisRequest} tokens in single request`, {
        sessionKey,
        agentId,
        model,
      });
      return true;
    }

    return false;
  }

  /**
   * Get today's stats.
   */
  getToday(): DailyStats {
    const dateStr = this.formatDate(Date.now());
    return this.getOrLoadDay(dateStr);
  }

  /**
   * Get stats for a specific date.
   */
  getDay(dateStr: string): DailyStats | null {
    const filePath = this.filePath(dateStr);
    if (!existsSync(filePath)) return null;

    try {
      const raw = readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as DailyStats;
    } catch (err) {
      logger.error(`Failed to load stats for ${dateStr}`, String(err));
      return null;
    }
  }

  // ---- Private ----

  private getOrLoadDay(dateStr: string): DailyStats {
    if (this.todayDate === dateStr && this.todayStats) {
      return this.todayStats;
    }

    const filePath = this.filePath(dateStr);
    let stats: DailyStats;

    if (existsSync(filePath)) {
      try {
        const raw = readFileSync(filePath, 'utf-8');
        stats = JSON.parse(raw) as DailyStats;
      } catch {
        stats = this.emptyStats(dateStr);
      }
    } else {
      stats = this.emptyStats(dateStr);
    }

    this.todayDate = dateStr;
    this.todayStats = stats;
    return stats;
  }

  private saveDay(dateStr: string, stats: DailyStats): void {
    const filePath = this.filePath(dateStr);
    try {
      writeFileSync(filePath, JSON.stringify(stats, null, 2), 'utf-8');
    } catch (err) {
      logger.error(`Failed to save stats for ${dateStr}`, String(err));
    }
  }

  private filePath(dateStr: string): string {
    return join(this.statsDir, `token-usage-${dateStr}.json`);
  }

  private emptyStats(dateStr: string): DailyStats {
    return {
      date: dateStr,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalRequests: 0,
      byAgent: {},
      byModel: {},
      records: [],
    };
  }

  private formatDate(ts: number): string {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}
