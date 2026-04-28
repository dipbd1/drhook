import { DeliveryError } from '../errors.js';
import type { StorageAdapter } from '../storage/StorageAdapter.js';
import type { Delivery } from '../types.js';
import { sendHttpDelivery } from './http.js';
import { calculateRetryDelayMs } from './retry.js';

export interface DeliveryWorkerOptions {
  storage: StorageAdapter;
  maxAttempts: number;
  deliveryTimeoutMs: number;
  pollIntervalMs: number;
  batchSize: number;
}

export class DeliveryWorker {
  private readonly storage: StorageAdapter;
  private readonly maxAttempts: number;
  private readonly deliveryTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(options: DeliveryWorkerOptions) {
    this.storage = options.storage;
    this.maxAttempts = options.maxAttempts;
    this.deliveryTimeoutMs = options.deliveryTimeoutMs;
    this.pollIntervalMs = options.pollIntervalMs;
    this.batchSize = options.batchSize;
  }

  async start(): Promise<void> {
    if (this.timer) {
      return;
    }

    await this.processDueDeliveries();

    this.timer = setInterval(() => {
      void this.processDueDeliveries();
    }, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  async processDueDeliveries(now = new Date()): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      const dueDeliveries = await this.storage.fetchDueDeliveries(this.batchSize, now);

      for (const delivery of dueDeliveries) {
        await this.processDelivery(delivery);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private async processDelivery(delivery: Delivery): Promise<void> {
    const claimedDelivery = await this.storage.markDeliveryInProgress(delivery.id);

    if (!claimedDelivery) {
      return;
    }

    try {
      const result = await sendHttpDelivery(claimedDelivery, this.deliveryTimeoutMs);
      await this.storage.recordDeliverySuccess(claimedDelivery.id, result.statusCode);
    } catch (error) {
      await this.recordFailedAttempt(claimedDelivery, error);
    }
  }

  private async recordFailedAttempt(delivery: Delivery, error: unknown): Promise<void> {
    const attempts = delivery.attempts + 1;
    const reachedFinalAttempt = attempts >= this.maxAttempts;
    const finalStatus = reachedFinalAttempt ? 'failed' : 'pending';
    const delayMs = calculateRetryDelayMs(attempts);
    const nextAttemptAt = reachedFinalAttempt ? null : new Date(Date.now() + delayMs);

    let statusCode: number | null = null;
    let message = 'Webhook delivery failed';

    if (error instanceof DeliveryError) {
      statusCode = error.statusCode;
      message = error.message;
    } else if (error instanceof Error) {
      message = error.message;
    }

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
