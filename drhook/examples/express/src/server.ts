import express from 'express';
import { createWebhooks } from '../../../src/index.js';

const port = Number(process.env.PORT ?? 3000);
const databaseUrl = process.env.WEBHOOK_DATABASE_URL ?? './webhooks.sqlite';

const app = express();
app.use(express.json());

const webhooks = createWebhooks({
  databaseUrl,
  maxAttempts: 8,
  deliveryTimeoutMs: 5_000,
});

await webhooks.start();

app.post('/subscriptions', async (request, response, next) => {
  try {
    const { eventName, url } = request.body as { eventName?: string; url?: string };

    if (!eventName || !url) {
      response.status(400).json({ error: 'eventName and url are required' });
      return;
    }

    const subscription = await webhooks.register(eventName, url);
    response.status(201).json(subscription);
  } catch (error) {
    next(error);
  }
});

app.delete('/subscriptions', async (request, response, next) => {
  try {
    const { eventName, url } = request.body as { eventName?: string; url?: string };

    if (!eventName || !url) {
      response.status(400).json({ error: 'eventName and url are required' });
      return;
    }

    await webhooks.unregister(eventName, url);
    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.get('/subscriptions', async (_request, response, next) => {
  try {
    const subscriptions = await webhooks.listSubscriptions();
    response.json(subscriptions);
  } catch (error) {
    next(error);
  }
});

app.post('/events/:eventName', async (request, response, next) => {
  try {
    const deliveries = await webhooks.emit(request.params.eventName, request.body);
    response.status(202).json({ deliveries });
  } catch (error) {
    next(error);
  }
});

app.get('/deliveries', async (_request, response, next) => {
  try {
    const deliveries = await webhooks.listDeliveries();
    response.json(deliveries);
  } catch (error) {
    next(error);
  }
});

app.post('/demo-receiver', (request, response) => {
  console.log('received webhook', request.body);
  response.status(204).send();
});

app.use(
  (
    error: unknown,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction,
  ) => {
    if (error instanceof Error) {
      response.status(400).json({ error: error.message });
      return;
    }

    response.status(500).json({ error: 'Unexpected error' });
  },
);

const server = app.listen(port, () => {
  console.log(`drhook example listening on http://localhost:${port}`);
});

async function shutdown(): Promise<void> {
  await webhooks.stop();
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', () => {
  void shutdown();
});

process.on('SIGTERM', () => {
  void shutdown();
});
