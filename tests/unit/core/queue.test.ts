/**
 * 消息排队单元测试
 * 对应 TEST_PLAN: QUE-001 ~ QUE-005
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 模拟消息排队逻辑（基于 PRD 第4.2章设计）
interface QueuedMessage {
  id: string;
  content: string;
  timestamp: number;
}

type QueueMode = 'followup' | 'steer' | 'interrupt';

class MessageQueue {
  private queue: QueuedMessage[] = [];
  private processing = false;
  private mode: QueueMode;
  private debounceMs: number;
  private debounceTimer: NodeJS.Timeout | null = null;
  private maxConcurrent: number;
  private activeCount = 0;

  constructor(options: { mode?: QueueMode; debounceMs?: number; maxConcurrent?: number } = {}) {
    this.mode = options.mode || 'followup';
    this.debounceMs = options.debounceMs || 800;
    this.maxConcurrent = options.maxConcurrent || 10;
  }

  async enqueue(
    message: QueuedMessage,
    processor: (msg: QueuedMessage) => Promise<void>,
    onSteer?: (msg: QueuedMessage) => void,
    onInterrupt?: () => void,
  ): Promise<void> {
    if (this.activeCount >= this.maxConcurrent) {
      this.queue.push(message);
      return;
    }

    if (this.processing) {
      switch (this.mode) {
        case 'followup':
          this.queue.push(message);
          return;
        case 'steer':
          onSteer?.(message);
          return;
        case 'interrupt':
          onInterrupt?.();
          this.processing = false;
          break;
      }
    }

    this.processing = true;
    this.activeCount++;
    try {
      await processor(message);
    } finally {
      this.processing = false;
      this.activeCount--;
      // Process next in queue
      if (this.queue.length > 0) {
        const next = this.queue.shift()!;
        await this.enqueue(next, processor, onSteer, onInterrupt);
      }
    }
  }

  /** 防抖：合并连续消息 */
  debounce(message: QueuedMessage, onBatch: (messages: QueuedMessage[]) => void): void {
    this.queue.push(message);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      const batch = [...this.queue];
      this.queue = [];
      this.debounceTimer = null;
      onBatch(batch);
    }, this.debounceMs);
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  get isProcessing(): boolean {
    return this.processing;
  }
}

describe('Message Queue', () => {
  // QUE-001: followup 模式
  it('should queue messages in followup mode', async () => {
    const queue = new MessageQueue({ mode: 'followup' });
    const processOrder: string[] = [];

    const processor = async (msg: QueuedMessage) => {
      await new Promise((r) => setTimeout(r, 50));
      processOrder.push(msg.id);
    };

    // 同时入队两条消息
    const p1 = queue.enqueue({ id: 'msg1', content: 'first', timestamp: 1 }, processor);
    const p2 = queue.enqueue({ id: 'msg2', content: 'second', timestamp: 2 }, processor);

    await Promise.all([p1, p2]);

    expect(processOrder).toEqual(['msg1', 'msg2']);
  });

  // QUE-002: steer 模式
  it('should steer new messages into current conversation', async () => {
    const queue = new MessageQueue({ mode: 'steer' });
    const steered: QueuedMessage[] = [];

    const processor = async (msg: QueuedMessage) => {
      await new Promise((r) => setTimeout(r, 100));
    };

    const onSteer = (msg: QueuedMessage) => {
      steered.push(msg);
    };

    // 第一条开始处理
    const p1 = queue.enqueue({ id: 'msg1', content: 'first', timestamp: 1 }, processor, onSteer);

    // 第二条在处理中到达
    await new Promise((r) => setTimeout(r, 10));
    queue.enqueue({ id: 'msg2', content: 'second', timestamp: 2 }, processor, onSteer);

    await p1;

    expect(steered).toHaveLength(1);
    expect(steered[0].id).toBe('msg2');
  });

  // QUE-003: interrupt 模式
  it('should interrupt current processing for new messages', async () => {
    const queue = new MessageQueue({ mode: 'interrupt' });
    let interrupted = false;

    const processor = async (msg: QueuedMessage) => {
      await new Promise((r) => setTimeout(r, 100));
    };

    const onInterrupt = () => {
      interrupted = true;
    };

    // 第一条开始处理
    const p1 = queue.enqueue({ id: 'msg1', content: 'first', timestamp: 1 }, processor, undefined, onInterrupt);

    // 中断
    await new Promise((r) => setTimeout(r, 10));
    queue.enqueue({ id: 'msg2', content: 'second', timestamp: 2 }, processor, undefined, onInterrupt);

    await p1;

    expect(interrupted).toBe(true);
  });

  // QUE-004: 防抖 800ms
  it('should debounce messages within 800ms window', async () => {
    const queue = new MessageQueue({ debounceMs: 100 }); // 使用 100ms 加速测试
    let batchReceived: QueuedMessage[] = [];

    const onBatch = (messages: QueuedMessage[]) => {
      batchReceived = messages;
    };

    // 快速连续发送 3 条消息
    queue.debounce({ id: 'msg1', content: 'a', timestamp: 1 }, onBatch);
    queue.debounce({ id: 'msg2', content: 'b', timestamp: 2 }, onBatch);
    queue.debounce({ id: 'msg3', content: 'c', timestamp: 3 }, onBatch);

    // 等待防抖完成
    await new Promise((r) => setTimeout(r, 200));

    expect(batchReceived).toHaveLength(3);
    expect(batchReceived.map((m) => m.id)).toEqual(['msg1', 'msg2', 'msg3']);
  });

  // QUE-005: 并发限制 ≤10
  it('should enforce max concurrent limit', async () => {
    const queue = new MessageQueue({ mode: 'followup', maxConcurrent: 2 });
    let activeCount = 0;
    let maxActive = 0;

    const processor = async (msg: QueuedMessage) => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      await new Promise((r) => setTimeout(r, 50));
      activeCount--;
    };

    // 入队 5 条消息
    const promises = Array.from({ length: 5 }, (_, i) =>
      queue.enqueue({ id: `msg${i}`, content: `content${i}`, timestamp: i }, processor),
    );

    await Promise.all(promises);

    // 最大并发不超过 2
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
