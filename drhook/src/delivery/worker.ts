import { DeliveryError } from '../errors.js';
import type { StorageAdapter } from '../storage/StorageAdapter.js';
import type { Delivery } from '../types.js';
import { sendHttpDelivery } from './http.js';
import { calculateRetryDelayMs, isRetryableStatusCode } from './retry.js';

export interface DeliveryWorkerOptions {
  storage: StorageAdapter;
  maxAttempts: number;
  deliveryTimeoutMs: number;
  pollIntervalMs: number;
  batchSize: number;
  deliveryConcurrency: number;
  signingSecret?: string;
}

export class DeliveryWorker {
  private readonly storage: StorageAdapter;
  private readonly maxAttempts: number;
  private readonly deliveryTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly deliveryConcurrency: number;
  private readonly signingSecret: string | undefined;
  private timer: NodeJS.Timeout | null = null;
  private processingPromise: Promise<void> | null = null;

  constructor(options: DeliveryWorkerOptions) {
    this.storage = options.storage;
    this.maxAttempts = options.maxAttempts;
    this.deliveryTimeoutMs = options.deliveryTimeoutMs;
    this.pollIntervalMs = options.pollIntervalMs;
    this.batchSize = options.batchSize;
    this.deliveryConcurrency = options.deliveryConcurrency;
    this.signingSecret = options.signingSecret;
  }

  async start(): Promise<void> {
    if (this.timer) {
      return;
    }

    await this.processDueDeliveries();

    this.timer = setInterval(() => {
      void this.processDueDeliveries().catch(() => {
        // Keep interval-triggered failures from becoming unhandled rejections.
      });
    }, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    await this.processingPromise;
  }

  async processDueDeliveries(now = new Date()): Promise<void> {
    if (this.processingPromise) {
      return this.processingPromise;
    }

    const processingPromise = this.processDueDeliveriesOnce(now).finally(() => {
      if (this.processingPromise === processingPromise) {
        this.processingPromise = null;
      }
    });

    this.processingPromise = processingPromise;

    return processingPromise;
  }

  private async processDueDeliveriesOnce(now: Date): Promise<void> {
    const dueDeliveries = await this.storage.fetchDueDeliveries(this.batchSize, now);

    await processWithConcurrency(dueDeliveries, this.deliveryConcurrency, (delivery) =>
      this.processDelivery(delivery),
    );
  }

  private async processDelivery(delivery: Delivery): Promise<void> {
    const claimedDelivery = await this.storage.markDeliveryInProgress(delivery.id);

    if (!claimedDelivery) {
      return;
    }

    try {
      const result = await sendHttpDelivery(
        claimedDelivery,
        this.deliveryTimeoutMs,
        this.signingSecret,
      );
      await this.storage.recordDeliverySuccess(claimedDelivery.id, result.statusCode);
    } catch (error) {
      await this.recordFailedAttempt(claimedDelivery, error);
    }
  }

  private async recordFailedAttempt(delivery: Delivery, error: unknown): Promise<void> {
    const attempts = delivery.attempts + 1;
    let statusCode: number | null = null;
    let message = 'Webhook delivery failed';

    if (error instanceof DeliveryError) {
      statusCode = error.statusCode;
      message = error.message;
    } else if (error instanceof Error) {
      message = error.message;
    }

    const shouldRetry = isRetryableStatusCode(statusCode);
    const reachedFinalAttempt = attempts >= this.maxAttempts;
    const finalFailure = reachedFinalAttempt || !shouldRetry;
    const finalStatus = finalFailure ? 'failed' : 'pending';
    const delayMs = calculateRetryDelayMs(attempts);
    const nextAttemptAt = finalFailure ? null : new Date(Date.now() + delayMs);

    await this.storage.recordDeliveryFailure({
      deliveryId: delivery.id,
      statusCode,
      error: message,
      attempts,
      nextAttemptAt,
      finalStatus,
    });
  }
}

async function processWithConcurrency<T>(
  items: T[],
  concurrency: number,
  handler: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await handler(items[index]!);
    }
  });

  const results = await Promise.allSettled(workers);
  const rejection = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );

  if (rejection) {
    throw rejection.reason;
  }
}
