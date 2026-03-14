import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  appendFileSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { createWriteStream, createReadStream } from 'fs';
import { createGzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { createLogger } from '../utils/logger.js';
import type { Message } from '../ai/types.js';
import type { SessionConfig } from './config.js';

const logger = createLogger('session');

/** Size threshold for archiving a session file (10MB). */
const ARCHIVE_SIZE_BYTES = 10 * 1024 * 1024;

/** Number of recent messages to keep after archiving. */
const ARCHIVE_KEEP_MESSAGES = 200;

/** Default max context messages sent to AI. */
const DEFAULT_MAX_CONTEXT = 100;

/**
 * A single stored message entry in JSONL.
 */
export interface SessionEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

/**
 * In-memory session data.
 */
export interface Session {
  key: string;
  transcript: SessionEntry[];
  createdAt: number;
  lastActiveAt: number;
}

/**
 * SessionManager handles conversation history persistence and lifecycle.
 *
 * Session key format: `{channel}:{chatType}:{chatId}`
 * Storage path: `~/.my-agent/sessions/{sessionKey}.jsonl`
 */
export class SessionManager {
  private readonly sessionsDir: string;
  private readonly archiveDir: string;
  private readonly sessions: Map<string, Session> = new Map();
  private readonly resetKind: 'daily' | 'manual' | 'never';
  private readonly resetTime: string;
  private readonly maxContextMessages: number;
  private dailyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config?: SessionConfig) {
    this.sessionsDir = join(homedir(), '.my-agent', 'sessions');
    this.archiveDir = join(this.sessionsDir, 'archive');
    this.resetKind = config?.reset?.kind ?? 'daily';
    this.resetTime = config?.reset?.time ?? '04:00';
    this.maxContextMessages = config?.maxContextMessages ?? DEFAULT_MAX_CONTEXT;

    mkdirSync(this.sessionsDir, { recursive: true });
    mkdirSync(this.archiveDir, { recursive: true });

    if (this.resetKind === 'daily') {
      this.scheduleDailyReset();
    }
  }

  /**
   * Build a session key from channel info.
   */
  static buildKey(channel: string, chatType: 'direct' | 'group', chatId: string): string {
    return `${channel}:${chatType}:${chatId}`;
  }

  /**
   * Get or create a session, loading from disk if needed.
   */
  getOrCreate(key: string): Session {
    let session = this.sessions.get(key);
    if (session) {
      return session;
    }

    // Load from JSONL on disk
    const filePath = this.sessionFilePath(key);
    const transcript = this.loadTranscript(filePath);

    session = {
      key,
      transcript,
      createdAt: transcript.length > 0 ? transcript[0]!.timestamp : Date.now(),
      lastActiveAt: transcript.length > 0 ? transcript[transcript.length - 1]!.timestamp : Date.now(),
    };

    this.sessions.set(key, session);
    return session;
  }

  /**
   * Append a message to the session and persist to disk.
   */
  async addMessage(key: string, role: 'user' | 'assistant', content: string): Promise<void> {
    const session = this.getOrCreate(key);
    const entry: SessionEntry = {
      role,
      content,
      timestamp: Date.now(),
    };

    session.transcript.push(entry);
    session.lastActiveAt = entry.timestamp;

    // Append to JSONL file
    const filePath = this.sessionFilePath(key);
    this.appendEntry(filePath, entry);

    // Check if archive is needed
    await this.archiveIfNeeded(key);
  }

  /**
   * Get the context window messages for AI consumption.
   * Returns at most `maxContextMessages` recent messages as AI Message format.
   */
  getContext(key: string): Message[] {
    const session = this.getOrCreate(key);
    const slice = session.transcript.slice(-this.maxContextMessages);
    return slice.map((entry) => ({
      role: entry.role,
      content: entry.content,
    }));
  }

  /**
   * Reset a session (clear transcript), used for manual or daily resets.
   */
  async reset(key: string): Promise<void> {
    const session = this.sessions.get(key);
    if (session) {
      session.transcript = [];
      session.createdAt = Date.now();
      session.lastActiveAt = Date.now();
    }

    // Archive the current file and start fresh
    const filePath = this.sessionFilePath(key);
    if (existsSync(filePath)) {
      await this.archiveFile(filePath, key);
    }

    logger.info(`Session reset: ${key}`);
  }

  /**
   * Reset all active sessions (used for daily reset).
   */
  async resetAll(): Promise<void> {
    const keys = [...this.sessions.keys()];
    for (const key of keys) {
      await this.reset(key);
    }
    logger.info(`Daily reset: cleared ${keys.length} sessions`);
  }

  /**
   * Remove a session from memory (does not delete files).
   */
  evict(key: string): void {
    this.sessions.delete(key);
  }

  /**
   * Stop the daily reset timer.
   */
  dispose(): void {
    if (this.dailyTimer !== null) {
      clearTimeout(this.dailyTimer);
      this.dailyTimer = null;
    }
  }

  // ---- Private helpers ----

  private sessionFilePath(key: string): string {
    // Replace colons with underscores for filesystem safety
    const safeKey = key.replace(/:/g, '_');
    return join(this.sessionsDir, `${safeKey}.jsonl`);
  }

  private loadTranscript(filePath: string): SessionEntry[] {
    if (!existsSync(filePath)) {
      return [];
    }

    const entries: SessionEntry[] = [];
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch (err) {
      logger.error(`Failed to read session file ${filePath}: ${String(err)}`);
      return [];
    }

    const lines = raw.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;

      try {
        const entry = JSON.parse(trimmed) as SessionEntry;
        if (entry.role && entry.content !== undefined && entry.timestamp) {
          entries.push(entry);
        }
      } catch {
        logger.warn(`Skipping malformed JSONL line in ${filePath}`);
      }
    }

    return entries;
  }

  private appendEntry(filePath: string, entry: SessionEntry): void {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const line = JSON.stringify(entry) + '\n';
    try {
      appendFileSync(filePath, line, { flag: 'a' });
      // fsync for durability
      const fd = openSync(filePath, 'r');
      fsyncSync(fd);
      closeSync(fd);
    } catch (err) {
      logger.error(`Failed to append to session file ${filePath}: ${String(err)}`);
    }
  }

  private async archiveIfNeeded(key: string): Promise<void> {
    const filePath = this.sessionFilePath(key);
    if (!existsSync(filePath)) return;

    try {
      const stat = statSync(filePath);
      if (stat.size > ARCHIVE_SIZE_BYTES) {
        logger.info(`Session file exceeds ${ARCHIVE_SIZE_BYTES} bytes, archiving: ${key}`);
        await this.archiveAndTruncate(filePath, key);
      }
    } catch {
      // Stat failed, ignore
    }
  }

  private async archiveAndTruncate(filePath: string, key: string): Promise<void> {
    // Archive the full file
    await this.archiveFile(filePath, key);

    // Rewrite with only the most recent messages
    const session = this.sessions.get(key);
    if (session) {
      const kept = session.transcript.slice(-ARCHIVE_KEEP_MESSAGES);
      session.transcript = kept;

      const lines = kept.map((e) => JSON.stringify(e)).join('\n') + '\n';
      writeFileSync(filePath, lines, 'utf-8');
    }
  }

  private async archiveFile(filePath: string, key: string): Promise<void> {
    if (!existsSync(filePath)) return;

    const safeKey = key.replace(/:/g, '_');
    const archiveName = `${safeKey}.${Date.now()}.jsonl.gz`;
    const archivePath = join(this.archiveDir, archiveName);

    try {
      const source = createReadStream(filePath);
      const gzip = createGzip();
      const destination = createWriteStream(archivePath);
      await pipeline(source, gzip, destination);
      logger.info(`Archived session to ${archivePath}`);
    } catch (err) {
      logger.error(`Failed to archive session ${key}: ${String(err)}`);
    }
  }

  private scheduleDailyReset(): void {
    const msUntilReset = this.msUntilNextReset();
    logger.info(`Daily reset scheduled in ${Math.round(msUntilReset / 1000 / 60)} minutes`);

    this.dailyTimer = setTimeout(async () => {
      try {
        await this.resetAll();
      } catch (err) {
        logger.error(`Daily reset failed: ${String(err)}`);
      }
      // Reschedule for next day
      this.scheduleDailyReset();
    }, msUntilReset);

    // Unref so it doesn't keep the process alive
    if (this.dailyTimer && typeof this.dailyTimer === 'object' && 'unref' in this.dailyTimer) {
      (this.dailyTimer as NodeJS.Timeout).unref();
    }
  }

  private msUntilNextReset(): number {
    const [hours, minutes] = this.resetTime.split(':').map(Number) as [number, number];
    const now = new Date();
    const target = new Date(now);
    target.setHours(hours, minutes, 0, 0);

    if (target.getTime() <= now.getTime()) {
      // Already past today's reset time, schedule for tomorrow
      target.setDate(target.getDate() + 1);
    }

    return target.getTime() - now.getTime();
  }
}
