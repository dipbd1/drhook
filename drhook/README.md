# drhook

Small durable webhook delivery for Node.js 20+.

`drhook` stores webhook work in SQLite before delivery, retries failures with exponential backoff, and restores `in_progress` work to `pending` when the process restarts.

## Install

```bash
npm install drhook
```

## Quickstart

```ts
import { createWebhooks } from 'drhook';

const webhooks = createWebhooks({
  databaseUrl: './webhooks.sqlite',
  maxAttempts: 8,
  deliveryTimeoutMs: 5000,
  deliveryConcurrency: 5,
  signingSecret: process.env.WEBHOOK_SIGNING_SECRET,
});

await webhooks.start();

await webhooks.register('order.created', 'https://example.com/hook');

await webhooks.emit('order.created', {
  orderId: 123,
});
```

Webhook requests are sent as JSON:

```json
{
  "id": "delivery-id",
  "eventName": "order.created",
  "payload": {
    "orderId": 123
  }
}
```

When `signingSecret` is configured, webhook requests include:

```text
x-drhook-signature: sha256=<hmac>
x-drhook-timestamp: <unix-seconds>
```

The HMAC is `sha256` over `<timestamp>.<raw request body>`. Receivers should verify the
signature against the exact raw JSON body they received and reject stale timestamps.

## API

```ts
webhooks.register(eventName, url);
webhooks.unregister(eventName, url);
webhooks.emit(eventName, payload);
webhooks.start();
webhooks.stop();
webhooks.listSubscriptions();
webhooks.listDeliveries();
```

`deliveryConcurrency` controls how many queued webhooks are sent at the same time from each fetched batch. The default is `5`.

## Development

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run build
```

Run the Express example:

```bash
npm run dev
```

Then try it:

```bash
curl -X POST http://localhost:3000/subscriptions \
  -H 'content-type: application/json' \
  -d '{"eventName":"order.created","url":"http://localhost:3000/demo-receiver"}'

curl -X POST http://localhost:3000/events/order.created \
  -H 'content-type: application/json' \
  -d '{"orderId":123}'
```

## Status

This is intentionally small. It is a good starting point for service-owned webhooks, background jobs, and local durable delivery without bringing in a queue service.
