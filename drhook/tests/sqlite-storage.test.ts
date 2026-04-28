import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteStorage } from '../src/storage/SQLiteStorage.js';

describe('SQLiteStorage', () => {
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'drhook-'));
  });

  afterEach(async () => {
    await rm(temporaryDirectory, {
      recursive: true,
      force: true,
    });
  });

  it('stores subscriptions idempotently', async () => {
    const storage = new SQLiteStorage(join(temporaryDirectory, 'webhooks.sqlite'));
    await storage.initialize();

    const firstSubscription = await storage.registerSubscription(
      'order.created',
      'https://example.com/hook',
    );
    const secondSubscription = await storage.registerSubscription(
      'order.created',
      'https://example.com/hook',
    );

    const subscriptions = await storage.listSubscriptions();

    expect(firstSubscription.id).toBe(secondSubscription.id);
    expect(subscriptions).toHaveLength(1);

    await storage.close();
  });

  it('creates one pending delivery per subscription', async () => {
    const storage = new SQLiteStorage(join(temporaryDirectory, 'webhooks.sqlite'));
    await storage.initialize();

    const firstSubscription = await storage.registerSubscription(
      'order.created',
      'https://example.com/first',
    );
    const secondSubscription = await storage.registerSubscription(
      'order.created',
      'https://example.com/second',
    );

    const deliveries = await storage.createDeliveries([
      {
        eventName: 'order.created',
        payload: { orderId: 123 },
        subscriptionId: firstSubscription.id,
        url: firstSubscription.url,
      },
      {
        eventName: 'order.created',
        payload: { orderId: 123 },
        subscriptionId: secondSubscription.id,
        url: secondSubscription.url,
      },
    ]);

    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]?.status).toBe('pending');
    expect(deliveries[0]?.payload).toEqual({ orderId: 123 });

    await storage.close();
  });

  it('moves in-progress deliveries back to pending on restart', async () => {
    const databaseUrl = join(temporaryDirectory, 'webhooks.sqlite');
    const storage = new SQLiteStorage(databaseUrl);
    await storage.initialize();

    const subscription = await storage.registerSubscription(
      'order.created',
      'https://example.com/hook',
    );
    const [delivery] = await storage.createDeliveries([
      {
        eventName: 'order.created',
        payload: { orderId: 123 },
        subscriptionId: subscription.id,
        url: subscription.url,
      },
    ]);

    expect(delivery).toBeDefined();

    if (!delivery) {
      throw new Error('Expected a delivery to be created');
    }

    const claimedDelivery = await storage.markDeliveryInProgress(delivery.id);
    expect(claimedDelivery?.status).toBe('in_progress');

    await storage.close();

    const restartedStorage = new SQLiteStorage(databaseUrl);
    await restartedStorage.initialize();
    await restartedStorage.resetInProgressDeliveries();

    const [restoredDelivery] = await restartedStorage.listDeliveries();

    expect(restoredDelivery?.status).toBe('pending');

    await restartedStorage.close();
  });
});
