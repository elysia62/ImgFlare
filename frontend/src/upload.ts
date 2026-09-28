/** Upload queue: three concurrent tasks, two retries, SHA-256 deduplication. */

import { ApiError, checkDuplicate, uploadFile } from './api.js';
import { IMAGE_EXT, sha256Hex } from '../../shared/image.js';
import { formatBytes } from './ui.js';
import type { UploadResult, UploadTask } from './types.js';

const MAX_CONCURRENCY = 3;
const MAX_RETRIES = 2;

type Listener = () => void;

export class UploadQueue {
  private readonly tasks = new Map<string, UploadTask>();
  private readonly order: string[] = [];
  private readonly listeners = new Set<Listener>();
  private running = 0;
  private pending: string[] = [];
  private counter = 0;

  /** The configured maximum, or the server cap, whichever the caller knows. */
  constructor(private readonly maxFileSize: number) {}

  // -- subscription ---------------------------------------------------------

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  // -- reads ---------------------------------------------------------------

  /** Tasks in insertion order. */
  list(): UploadTask[] {
    return this.order
      .map((key) => this.tasks.get(key))
      .filter((task): task is UploadTask => task !== undefined);
  }

  /** Total queued or in-flight work, for the "busy" indicator. */
  get activeCount(): number {
    return this.pending.length + this.running;
  }

  // -- writes --------------------------------------------------------------

  /** Add files to the queue and start processing. */
  add(files: Iterable<File>): void {
    for (const file of files) {
      if (file.size === 0) {
        continue;
      }
      if (!IMAGE_EXT.test(file.name)) {
        const key = this.nextKey();
        this.tasks.set(key, {
          key,
          file,
          state: 'failed',
          progress: 0,
          error: '只支持图片（png、jpg、webp、gif、avif、svg、jxl、heic、tiff 等）',
          attempts: 0,
        });
        this.order.push(key);
        continue;
      }
      if (file.size > this.maxFileSize) {
        // Surface the rejection immediately rather than at upload time.
        const key = this.nextKey();
        this.tasks.set(key, {
          key,
          file,
          state: 'failed',
          progress: 0,
          error: `文件超过大小限制（最大 ${formatBytes(this.maxFileSize)}）`,
          attempts: 0,
        });
        this.order.push(key);
        continue;
      }

      const key = this.nextKey();
      this.tasks.set(key, {
        key,
        file,
        state: 'pending',
        progress: 0,
        attempts: 0,
      });
      this.order.push(key);
      this.pending.push(key);
    }

    this.notify();
    this.pump();
  }

  /** Re-run a task that failed. */
  retry(key: string): void {
    const task = this.tasks.get(key);
    if (!task || task.state !== 'failed') return;

    task.state = 'pending';
    task.error = undefined;
    task.progress = 0;
    task.attempts = 0;
    this.pending.push(key);
    this.notify();
    this.pump();
  }

  /** Drop a task from the visible list. */
  remove(key: string): void {
    const task = this.tasks.get(key);
    // Never remove work that is still in flight.
    if (task && (task.state === 'pending' || task.state === 'uploading')) return;

    this.tasks.delete(key);
    const index = this.order.indexOf(key);
    if (index >= 0) this.order.splice(index, 1);
    this.notify();
  }

  /** Clear every finished task. */
  clearFinished(): void {
    for (const key of [...this.order]) {
      const task = this.tasks.get(key);
      if (task && task.state !== 'pending' && task.state !== 'uploading') {
        this.tasks.delete(key);
        this.order.splice(this.order.indexOf(key), 1);
      }
    }
    this.notify();
  }

  // -- scheduler -----------------------------------------------------------

  private pump(): void {
    while (this.running < MAX_CONCURRENCY && this.pending.length > 0) {
      const key = this.pending.shift();
      if (key === undefined) break;

      const task = this.tasks.get(key);
      if (!task) continue;

      this.running += 1;
      void this.process(task).finally(() => {
        this.running -= 1;
        this.pump();
        this.notify();
      });
    }
  }

  private async process(task: UploadTask): Promise<void> {
    try {
      // 1. Hash locally.
      task.state = 'hashing';
      this.notify();
      const sha256 = await sha256Hex(task.file);

      // 2. Ask the server whether these bytes already exist.
      task.state = 'checking';
      this.notify();
      const check = await checkDuplicate(sha256);

      if (check.exists && check.file) {
        // Already stored: report success without sending a single byte.
        task.state = 'duplicate';
        task.result = {
          success: true,
          deduplicated: true,
          file: check.file,
        };
        task.progress = 1;
        this.notify();
        return;
      }

      // 3. Upload, with bounded retries.
      await this.uploadWithRetry(task, sha256);
    } catch (error) {
      this.failTask(task, error);
    } finally {
      this.notify();
    }
  }

  private async uploadWithRetry(task: UploadTask, sha256: string): Promise<void> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      task.attempts = attempt;
      task.state = 'uploading';
      task.progress = 0;
      this.notify();

      try {
        const result: UploadResult = await uploadFile(task.file, sha256, (fraction) => {
          task.progress = fraction;
          this.notify();
        });

        task.result = result;
        task.state = 'success';
        task.progress = 1;
        this.notify();
        return;
      } catch (error) {
        // A 4xx other than 429/408 will not succeed on retry.
        if (error instanceof ApiError && isPermanent(error)) {
          throw error;
        }
        if (attempt === MAX_RETRIES) throw error;

        // Brief backoff before the next attempt.
        await delay(400 * (attempt + 1));
      }
    }
  }

  private failTask(task: UploadTask, error: unknown): void {
    task.state = 'failed';
    task.progress = 0;

    if (error instanceof ApiError) {
      task.error = error.code === 'network_error' ? '网络错误，请重试' : error.code;
    } else if (error instanceof Error) {
      task.error = error.message;
    } else {
      task.error = 'unknown_error';
    }
  }

  private nextKey(): string {
    this.counter += 1;
    return `task-${this.counter}-${Date.now()}`;
  }
}

/** Is retrying this error pointless? */
function isPermanent(error: ApiError): boolean {
  if (error.status === 0) return false; // network error — worth a retry
  if (error.status === 429 || error.status === 408) return false;
  return error.status >= 400 && error.status < 500;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
