import { ValidationError } from './errors.js';
import { DeliveryWorker } from './delivery/worker.js';
import { SQLiteStorage } from './storage/SQLiteStorage.js';
import type { ReliableWebhooks, WebhooksConfig } from './types.js';
import type { StorageAdapter } from './storage/StorageAdapter.js';

const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_DELIVERY_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_BATCH_SIZE = 25;

export function createWebhooks(config: WebhooksConfig): ReliableWebhooks {
  validateConfig(config);

  const storage = new SQLiteStorage(config.databaseUrl);
  const worker = new DeliveryWorker({
    storage,
    maxAttempts: config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    deliveryTimeoutMs: config.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS,
    pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    batchSize: config.batchSize ?? DEFAULT_BATCH_SIZE,
  });

  let isInitialized = false;

  async function ensureInitialized(): Promise<void> {
    if (isInitialized) {
      return;
    }

    await storage.initialize();
    await storage.resetInProgressDeliveries();
    isInitialized = true;
  }

  return {
    async register(eventName, url) {
      await ensureInitialized();
      validateEventName(eventName);
      validateUrl(url);

      return storage.registerSubscription(eventName, url);
    },

    async unregister(eventName, url) {
      await ensureInitialized();
      validateEventName(eventName);
      validateUrl(url);

      await storage.unregisterSubscription(eventName, url);
    },

    async emit(eventName, payload) {
      await ensureInitialized();
      validateEventName(eventName);
      ensureSerializablePayload(payload);

      const subscriptions = await storage.listSubscriptions(eventName);
      const deliveryInputs = subscriptions.map((subscription) => ({
        eventName,
        payload,
        subscriptionId: subscription.id,
        url: subscription.url,
      }));

      return storage.createDeliveries(deliveryInputs);
    },

    async start() {
      await ensureInitialized();
      await worker.start();
    },

    async stop() {
      await worker.stop();
    },

    async listSubscriptions() {
      await ensureInitialized();

      return storage.listSubscriptions();
    },

    async listDeliveries() {
      await ensureInitialized();

      return storage.listDeliveries();
    },
  };
}

export async function closeStorage(storage: StorageAdapter): Promise<void> {
  await storage.close();
}

function validateConfig(config: WebhooksConfig): void {
  if (!config.databaseUrl) {
    throw new ValidationError('databaseUrl is required');
  }

  validatePositiveInteger(config.maxAttempts, 'maxAttempts');
  validatePositiveInteger(config.deliveryTimeoutMs, 'deliveryTimeoutMs');
  validatePositiveInteger(config.pollIntervalMs, 'pollIntervalMs');
  validatePositiveInteger(config.batchSize, 'batchSize');
}

function validatePositiveInteger(value: number | undefined, name: string): void {
  if (value === undefined) {
    return;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${name} must be a positive integer`);
  }
}

function validateEventName(eventName: string): void {
  if (eventName.trim().length === 0) {
    throw new ValidationError('eventName is required');
  }
}

function validateUrl(url: string): void {
  try {
    const parsedUrl = new URL(url);

    if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
      return;
    }
  } catch {
    throw new ValidationError('url must be a valid HTTP or HTTPS URL');
  }

  throw new ValidationError('url must be a valid HTTP or HTTPS URL');
}

function ensureSerializablePayload(payload: unknown): void {
  try {
    JSON.stringify(payload);
  } catch {
    throw new ValidationError('payload must be JSON serializable');
  }
}
