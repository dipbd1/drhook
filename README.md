# drhook

Small durable webhook delivery for Node.js 20+.

`drhook` stores webhook work in SQLite before delivery, retries failures with exponential backoff, and restores `in_progress` work to `pending` when the process restarts.

## Install

```bash
npm install drhook
```

not yet published to npm (dont have npm pro)

## Quickstart

```ts
import { createWebhooks } from 'drhook';

const webhooks = createWebhooks({
  databaseUrl: './webhooks.sqlite',
  maxAttempts: 8,
  deliveryTimeoutMs: 5000,
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

## Development

```bash
cd drhook
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
