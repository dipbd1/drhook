# Process

## Goals

Keep the package small, durable, and easy to reason about.

The first version should do a few things well:

- Persist subscriptions and deliveries before attempting network work.
- Retry failed delivery with bounded exponential backoff.
- Make process restarts safe by moving `in_progress` deliveries back to `pending`.
- Keep the public API stable and small.

## Development Loop

Use this loop for changes:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Add focused tests when changing:

- subscription behavior
- delivery status transitions
- retry timing
- SQLite persistence
- worker failure handling

## Design Notes

`createWebhooks.ts` owns the public API and wires storage to the worker.

`storage/StorageAdapter.ts` keeps persistence replaceable. SQLite is the first adapter, but callers should not need to know that.

`delivery/worker.ts` owns background processing. It claims pending deliveries before sending them, then records success or failure.

`delivery/http.ts` owns the network boundary. It uses native Node.js `fetch` and an abort timeout.

`delivery/retry.ts` stays deterministic when jitter is disabled, which keeps tests simple.
