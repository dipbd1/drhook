import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebhooks } from '../src/index.js';
import { SQLiteStorage } from '../src/storage/SQLiteStorage.js';
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
    expect(() =>
      createWebhooks({
        databaseUrl: join(temporaryDirectory, 'webhooks.sqlite'),
        signingSecret: '',
      }),
    ).toThrow('signingSecret must not be empty');
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

  it('signs webhook requests when a signing secret is configured', async () => {
    const signingSecret = 'whsec_test_secret';
    let receivedRawBody: string | null = null;
    let receivedSignature: string | string[] | undefined;
    let receivedTimestamp: string | string[] | undefined;

    server = await createJsonServer((_body, response, request, rawBody) => {
      receivedRawBody = rawBody;
      receivedSignature = request.headers['x-drhook-signature'];
      receivedTimestamp = request.headers['x-drhook-timestamp'];
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
      signingSecret,
    });

    await webhooks.register('order.created', `http://127.0.0.1:${address.port}/hook`);
    await webhooks.start();
    await webhooks.emit('order.created', {
      orderId: 123,
    });

    await waitFor(() => receivedRawBody !== null);

    expect(typeof receivedRawBody).toBe('string');
    expect(typeof receivedTimestamp).toBe('string');
    expect(typeof receivedSignature).toBe('string');

    if (
      typeof receivedRawBody !== 'string' ||
      typeof receivedTimestamp !== 'string' ||
      typeof receivedSignature !== 'string'
    ) {
      throw new Error('Expected signature headers and raw body');
    }

    expect(receivedSignature).toBe(
      createExpectedSignature(signingSecret, receivedTimestamp, receivedRawBody),
    );
  });

  it('does not retry permanent client failures', async () => {
    let requestCount = 0;
    server = await createJsonServer((_body, response) => {
      requestCount += 1;
      response.statusCode = 400;
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
      maxAttempts: 3,
    });

    await webhooks.register('order.created', `http://127.0.0.1:${address.port}/hook`);
    await webhooks.start();
    await webhooks.emit('order.created', {
      orderId: 123,
    });

    await waitFor(async () => {
      if (!webhooks) {
        return false;
      }

      const [delivery] = await webhooks.listDeliveries();
      return delivery?.status === 'failed';
    });

    const [delivery] = await webhooks.listDeliveries();
    expect(delivery?.attempts).toBe(1);
    expect(delivery?.lastError).toBe('Webhook returned HTTP 400');
    expect(requestCount).toBe(1);
  });

  it('waits for an active delivery before closing storage on stop', async () => {
    const requestReceived = createDeferred<void>();
    const releaseResponse = createDeferred<void>();
    const databaseUrl = join(temporaryDirectory, 'webhooks.sqlite');

    server = await createJsonServer((body, response) => {
      expect(body).toMatchObject({
        eventName: 'order.created',
      });

      response.statusCode = 204;
      requestReceived.resolve();

      void releaseResponse.promise.then(() => {
        response.end();
      });
    });

    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Expected server to listen on a TCP port');
    }

    webhooks = createWebhooks({
      databaseUrl,
      pollIntervalMs: 10,
      deliveryTimeoutMs: 1_000,
    });

    await webhooks.register('order.created', `http://127.0.0.1:${address.port}/hook`);
    await webhooks.start();
    await webhooks.emit('order.created', {
      orderId: 123,
    });
    await requestReceived.promise;

    let stopResolved = false;
    const stopPromise = webhooks.stop().then(() => {
      stopResolved = true;
    });

    await delay(25);
    expect(stopResolved).toBe(false);

    releaseResponse.resolve();
    await stopPromise;
    webhooks = null;

    const restartedStorage = new SQLiteStorage(databaseUrl);
    await restartedStorage.initialize();

    const [delivery] = await restartedStorage.listDeliveries();
    expect(delivery?.status).toBe('succeeded');

    await restartedStorage.close();
  });

  it('continues delivering other webhooks when one endpoint is slow', async () => {
    const slowRequestReceived = createDeferred<void>();
    const releaseSlowResponse = createDeferred<void>();
    let fastRequestReceived = false;

    server = await createJsonServer((_body, response, request) => {
      if (request.url === '/slow') {
        response.statusCode = 204;
        slowRequestReceived.resolve();

        void releaseSlowResponse.promise.then(() => {
          response.end();
        });
        return;
      }

      if (request.url === '/fast') {
        response.statusCode = 204;
        fastRequestReceived = true;
        response.end();
        return;
      }

      response.statusCode = 404;
      response.end();
    });

    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Expected server to listen on a TCP port');
    }

    webhooks = createWebhooks({
      databaseUrl: join(temporaryDirectory, 'webhooks.sqlite'),
      pollIntervalMs: 10,
      deliveryTimeoutMs: 1_000,
      deliveryConcurrency: 2,
    });

    await webhooks.register('order.created', `http://127.0.0.1:${address.port}/slow`);
    await webhooks.register('order.created', `http://127.0.0.1:${address.port}/fast`);
    await webhooks.start();
    await webhooks.emit('order.created', {
      orderId: 123,
    });

    await slowRequestReceived.promise;

    try {
      await waitFor(() => fastRequestReceived);
      await waitFor(async () => {
        if (!webhooks) {
          return false;
        }

        const deliveries = await webhooks.listDeliveries();
        return deliveries.some(
          (delivery) => delivery.url.endsWith('/fast') && delivery.status === 'succeeded',
        );
      });
    } finally {
      releaseSlowResponse.resolve();
    }

    await waitFor(async () => {
      if (!webhooks) {
        return false;
      }

      const deliveries = await webhooks.listDeliveries();
      return deliveries.every((delivery) => delivery.status === 'succeeded');
    });
  });
});

async function createJsonServer(
  handler: (
    body: unknown,
    response: ServerResponse,
    request: IncomingMessage,
    rawBody: string,
  ) => void,
): Promise<Server> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = '';

    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });

    request.on('end', () => {
      const parsedBody = body ? (JSON.parse(body) as unknown) : null;
      handler(parsedBody, response, request, body);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  return server;
}

function createExpectedSignature(secret: string, timestamp: string, body: string): string {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

  return `sha256=${signature}`;
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

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
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
