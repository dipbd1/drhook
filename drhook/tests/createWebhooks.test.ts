import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebhooks } from '../src/index.js';
import type { ReliableWebhooks } from '../src/types.js';

describe('createWebhooks', () => {
  let temporaryDirectory: string;
  let webhooks: ReliableWebhooks | null = null;
  let server: Server | null = null;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'drhook-'));
  });

  afterEach(async () => {
    if (webhooks) {
      await webhooks.stop();
      webhooks = null;
    }

    if (server) {
      await closeServer(server);
      server = null;
    }

    await rm(temporaryDirectory, {
      recursive: true,
      force: true,
    });
  });

  it('registers subscriptions and queues deliveries', async () => {
    webhooks = createWebhooks({
      databaseUrl: join(temporaryDirectory, 'webhooks.sqlite'),
    });

    await webhooks.register('order.created', 'https://example.com/hook');

    const deliveries = await webhooks.emit('order.created', {
      orderId: 123,
    });

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.eventName).toBe('order.created');
    expect(deliveries[0]?.payload).toEqual({ orderId: 123 });
    expect(deliveries[0]?.status).toBe('pending');
  });

  it('does not queue deliveries when there are no subscribers', async () => {
    webhooks = createWebhooks({
      databaseUrl: join(temporaryDirectory, 'webhooks.sqlite'),
    });

    const deliveries = await webhooks.emit('order.created', {
      orderId: 123,
    });

    expect(deliveries).toEqual([]);
  });

  it('validates event names and urls', async () => {
    webhooks = createWebhooks({
      databaseUrl: join(temporaryDirectory, 'webhooks.sqlite'),
    });

    await expect(webhooks.register('', 'https://example.com/hook')).rejects.toThrow(
      'eventName is required',
    );
    await expect(webhooks.register('order.created', 'ftp://example.com/hook')).rejects.toThrow(
      'url must be a valid HTTP or HTTPS URL',
    );
  });

  it('delivers queued webhooks to subscribers', async () => {
    const receivedBodies: unknown[] = [];
    server = await createJsonServer((body, response) => {
      receivedBodies.push(body);
      response.statusCode = 204;
      response.end();
    });

    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Expected server to listen on a TCP port');
    }

    webhooks = createWebhooks({
      databaseUrl: join(temporaryDirectory, 'webhooks.sqlite'),
      pollIntervalMs: 25,
      deliveryTimeoutMs: 1_000,
    });

    await webhooks.register('order.created', `http://127.0.0.1:${address.port}/hook`);
    await webhooks.start();
    await webhooks.emit('order.created', {
      orderId: 123,
    });

    await waitFor(() => receivedBodies.length === 1);

    expect(receivedBodies[0]).toMatchObject({
      eventName: 'order.created',
      payload: {
        orderId: 123,
      },
    });

    await waitFor(async () => {
      if (!webhooks) {
        return false;
      }

      const [delivery] = await webhooks.listDeliveries();
      return delivery?.status === 'succeeded';
    });

    const [delivery] = await webhooks.listDeliveries();
    expect(delivery?.status).toBe('succeeded');
  });
});

async function createJsonServer(
  handler: (body: unknown, response: ServerResponse) => void,
): Promise<Server> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = '';

    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });

    request.on('end', () => {
      const parsedBody = body ? (JSON.parse(body) as unknown) : null;
      handler(parsedBody, response);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const startedAt = Date.now();
  const timeoutMs = 2_000;

  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }

  throw new Error('Timed out waiting for condition');
}
