#!/usr/bin/env node

const baseUrl = normalizeBaseUrl(process.env.BASE_URL ?? process.argv[2] ?? 'http://localhost:3000');
const runId = `test.script.${Date.now()}.${Math.random().toString(36).slice(2)}`;
const timeoutMs = Number(process.env.TEST_TIMEOUT_MS ?? 15_000);

const events = {
  success: `${runId}.success`,
  isolated: `${runId}.isolated`,
  empty: `${runId}.empty`,
  failure: `${runId}.failure`,
};

const urls = {
  firstReceiver: `${baseUrl}/demo-receiver?subscriber=first&run=${encodeURIComponent(runId)}`,
  secondReceiver: `${baseUrl}/demo-receiver?subscriber=second&run=${encodeURIComponent(runId)}`,
  isolatedReceiver: `${baseUrl}/demo-receiver?subscriber=isolated&run=${encodeURIComponent(runId)}`,
  failingReceiver: `${baseUrl}/missing-receiver-${encodeURIComponent(runId)}`,
};

const checks = [];
const testResults = [];
const requestMetrics = [];
const scriptStartedAt = performance.now();
let currentTestName = 'setup';
let suppressRequestMetrics = false;
const subscriptionsToCleanup = [
  [events.success, urls.firstReceiver],
  [events.success, urls.secondReceiver],
  [events.isolated, urls.isolatedReceiver],
  [events.failure, urls.failingReceiver],
];

try {
  await cleanupSubscriptions();
  await runTest('Read endpoints', testReadEndpoints);
  await runTest('Subscription validation', testSubscriptionValidation);
  await runTest('Event validation', testEventValidation);
  await runTest('Subscription lifecycle', testSubscriptionLifecycle);
  await runTest('Event isolation and empty events', testEventIsolationAndEmptyEvents);
  await runTest('Successful delivery flow', testDeliverySuccessFlow);
  await runTest('Failed delivery flow', testDeliveryFailureFlow);
  await runTest('Unsubscribe flow', testUnsubscribeFlow);
} catch (error) {
  console.error('\nTest script failed before all checks could run.');
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
} finally {
  await cleanupSubscriptions();
  printSummary();
}

async function runTest(name, testFunction) {
  const previousTestName = currentTestName;
  const startedAt = performance.now();
  const checksBefore = checks.length;
  const requestsBefore = requestMetrics.length;
  currentTestName = name;

  try {
    await testFunction();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(false, `${name} completes without throwing`, message);
  } finally {
    const durationMs = performance.now() - startedAt;
    const testChecks = checks.slice(checksBefore);
    const testRequests = requestMetrics.slice(requestsBefore);
    const failedChecks = testChecks.filter((checkResult) => !checkResult.passed);
    const requestDurations = testRequests.map((requestMetric) => requestMetric.durationMs);

    testResults.push({
      name,
      status: failedChecks.length === 0 ? 'PASS' : 'FAIL',
      checks: testChecks.length,
      failed: failedChecks.length,
      durationMs,
      requestCount: testRequests.length,
      averageRequestMs: average(requestDurations),
      slowestRequestMs: requestDurations.length > 0 ? Math.max(...requestDurations) : 0,
    });

    currentTestName = previousTestName;
  }
}

async function testReadEndpoints() {
  const subscriptionsResponse = await request('/subscriptions');
  expectStatus(subscriptionsResponse, 200, 'GET /subscriptions returns 200');
  check(
    Array.isArray(subscriptionsResponse.body),
    'GET /subscriptions returns an array body',
    `unexpected body: ${stringify(subscriptionsResponse.body)}`,
  );

  const deliveriesResponse = await request('/deliveries');
  expectStatus(deliveriesResponse, 200, 'GET /deliveries returns 200');
  check(
    Array.isArray(deliveriesResponse.body),
    'GET /deliveries returns an array body',
    `unexpected body: ${stringify(deliveriesResponse.body)}`,
  );
}

async function testSubscriptionValidation() {
  const missingUrlResponse = await request('/subscriptions', {
    method: 'POST',
    body: {
      eventName: events.success,
    },
  });
  expectStatus(missingUrlResponse, 400, 'POST /subscriptions rejects missing url');
  expectErrorMessage(
    missingUrlResponse,
    'eventName and url are required',
    'missing url response includes validation error',
  );

  const missingEventNameResponse = await request('/subscriptions', {
    method: 'POST',
    body: {
      url: urls.firstReceiver,
    },
  });
  expectStatus(missingEventNameResponse, 400, 'POST /subscriptions rejects missing eventName');

  const blankEventNameResponse = await request('/subscriptions', {
    method: 'POST',
    body: {
      eventName: '   ',
      url: urls.firstReceiver,
    },
  });
  expectStatus(blankEventNameResponse, 400, 'POST /subscriptions rejects blank eventName');
  expectErrorMessage(
    blankEventNameResponse,
    'eventName is required',
    'blank eventName response includes validation error',
  );

  const invalidUrlResponse = await request('/subscriptions', {
    method: 'POST',
    body: {
      eventName: events.success,
      url: 'ftp://example.com/hook',
    },
  });
  expectStatus(invalidUrlResponse, 400, 'POST /subscriptions rejects non-http url');
  expectErrorMessage(
    invalidUrlResponse,
    'url must be a valid HTTP or HTTPS URL',
    'invalid url response includes validation error',
  );

  const deleteMissingFieldsResponse = await request('/subscriptions', {
    method: 'DELETE',
    body: {
      eventName: events.success,
    },
  });
  expectStatus(deleteMissingFieldsResponse, 400, 'DELETE /subscriptions rejects missing url');
}

async function testEventValidation() {
  const invalidJsonResponse = await requestRaw(`/events/${encodeURIComponent(events.success)}`, {
    method: 'POST',
    body: '{"notValidJson":',
    headers: {
      'content-type': 'application/json',
    },
  });
  expectStatus(invalidJsonResponse, 400, 'POST /events/:eventName rejects invalid JSON');

  const blankEventResponse = await request(`/events/${encodeURIComponent('   ')}`, {
    method: 'POST',
    body: {
      ignored: true,
    },
  });
  expectStatus(blankEventResponse, 400, 'POST /events/:eventName rejects blank eventName');
  expectErrorMessage(
    blankEventResponse,
    'eventName is required',
    'blank emitted eventName response includes validation error',
  );
}

async function testSubscriptionLifecycle() {
  const firstSubscription = await createSubscription(events.success, urls.firstReceiver);
  const duplicateSubscription = await createSubscription(events.success, urls.firstReceiver);

  check(
    duplicateSubscription.body.id === firstSubscription.body.id,
    'duplicate subscription returns the existing subscription id',
    `first=${stringify(firstSubscription.body)} duplicate=${stringify(duplicateSubscription.body)}`,
  );

  await createSubscription(events.success, urls.secondReceiver);
  await createSubscription(events.isolated, urls.isolatedReceiver);

  const subscriptions = await listSubscriptions();
  const successSubscriptions = subscriptions.filter(
    (subscription) => subscription.eventName === events.success,
  );

  check(
    successSubscriptions.length === 2,
    'GET /subscriptions lists exactly two subscriptions for the success event',
    `matching subscriptions: ${stringify(successSubscriptions)}`,
  );
  check(
    successSubscriptions.some((subscription) => subscription.url === urls.firstReceiver) &&
      successSubscriptions.some((subscription) => subscription.url === urls.secondReceiver),
    'GET /subscriptions includes both success subscriber urls',
    `matching subscriptions: ${stringify(successSubscriptions)}`,
  );
  check(
    subscriptions.some(
      (subscription) =>
        subscription.eventName === events.isolated && subscription.url === urls.isolatedReceiver,
    ),
    'GET /subscriptions includes isolated event subscription',
    `all subscriptions: ${stringify(subscriptions)}`,
  );
}

async function testEventIsolationAndEmptyEvents() {
  const emptyEventResponse = await emitEvent(events.empty, {
    source: 'integration-test',
  });
  expectDeliveryCount(emptyEventResponse, 0, 'event with no subscribers queues no deliveries');

  const isolatedEventResponse = await emitEvent(events.isolated, {
    source: 'integration-test',
    nested: {
      value: true,
    },
  });
  expectDeliveryCount(isolatedEventResponse, 1, 'isolated event queues one delivery');
  check(
    isolatedEventResponse.body.deliveries[0]?.url === urls.isolatedReceiver,
    'isolated event delivers only to its own subscriber',
    `unexpected deliveries: ${stringify(isolatedEventResponse.body.deliveries)}`,
  );

  await waitForDeliveries(events.isolated, [urls.isolatedReceiver], 'succeeded');
  check(true, 'isolated event delivery reaches succeeded status');
}

async function testDeliverySuccessFlow() {
  const payload = {
    runId,
    nested: {
      string: 'value',
      number: 42,
      boolean: true,
      nullValue: null,
      array: ['a', 1, false],
    },
  };

  const eventResponse = await emitEvent(events.success, payload);
  expectDeliveryCount(eventResponse, 2, 'event with two subscribers queues two deliveries');
  check(
    eventResponse.body.deliveries.every((delivery) => deepEqual(delivery.payload, payload)),
    'queued deliveries preserve complex JSON payloads',
    `unexpected deliveries: ${stringify(eventResponse.body.deliveries)}`,
  );
  check(
    eventResponse.body.deliveries.every((delivery) => delivery.status === 'pending'),
    'queued deliveries start as pending',
    `unexpected deliveries: ${stringify(eventResponse.body.deliveries)}`,
  );

  await waitForDeliveries(events.success, [urls.firstReceiver, urls.secondReceiver], 'succeeded');
  check(true, 'all success event deliveries reach succeeded status');
}

async function testDeliveryFailureFlow() {
  await createSubscription(events.failure, urls.failingReceiver);

  const eventResponse = await emitEvent(events.failure, {
    runId,
    expectedFailure: true,
  });
  expectDeliveryCount(eventResponse, 1, 'event with failing subscriber queues one delivery');

  const failedAttempt = await waitForDeliveryAttempt(events.failure, urls.failingReceiver);
  check(
    failedAttempt.attempts >= 1,
    'failed receiver records at least one delivery attempt',
    `delivery: ${stringify(failedAttempt)}`,
  );
  check(
    failedAttempt.lastError?.includes('HTTP 404'),
    'failed receiver records the HTTP error',
    `delivery: ${stringify(failedAttempt)}`,
  );
}

async function testUnsubscribeFlow() {
  const deleteResponse = await request('/subscriptions', {
    method: 'DELETE',
    body: {
      eventName: events.success,
      url: urls.firstReceiver,
    },
  });
  expectStatus(deleteResponse, 204, 'DELETE /subscriptions removes a subscription');

  const subscriptions = await listSubscriptions();
  check(
    !subscriptions.some(
      (subscription) =>
        subscription.eventName === events.success && subscription.url === urls.firstReceiver,
    ),
    'deleted subscription no longer appears in subscription list',
    `all subscriptions: ${stringify(subscriptions)}`,
  );

  const eventResponse = await emitEvent(events.success, {
    runId,
    afterDelete: true,
  });
  expectDeliveryCount(eventResponse, 1, 'event after unsubscribe queues only remaining subscriber');
  check(
    eventResponse.body.deliveries[0]?.url === urls.secondReceiver,
    'event after unsubscribe targets the remaining subscriber',
    `unexpected deliveries: ${stringify(eventResponse.body.deliveries)}`,
  );

  await waitForDeliveries(events.success, [urls.secondReceiver], 'succeeded');
  check(true, 'remaining subscriber delivery succeeds after unsubscribe');
}

async function createSubscription(eventName, url) {
  const response = await request('/subscriptions', {
    method: 'POST',
    body: {
      eventName,
      url,
    },
  });

  expectStatus(response, 201, `POST /subscriptions creates ${eventName} -> ${url}`);
  check(
    hasStringProperty(response.body, 'id') &&
      response.body.eventName === eventName &&
      response.body.url === url &&
      isIsoDateString(response.body.createdAt),
    'created subscription has expected fields',
    `unexpected body: ${stringify(response.body)}`,
  );

  return response;
}

async function emitEvent(eventName, payload) {
  const response = await request(`/events/${encodeURIComponent(eventName)}`, {
    method: 'POST',
    body: payload,
  });
  expectStatus(response, 202, `POST /events/${eventName} queues deliveries`);
  check(
    hasDeliveryArray(response.body),
    'event response includes deliveries array',
    `unexpected body: ${stringify(response.body)}`,
  );

  return response;
}

async function listSubscriptions() {
  const response = await request('/subscriptions');
  expectStatus(response, 200, 'GET /subscriptions returns subscriptions');

  if (!Array.isArray(response.body)) {
    throw new Error(`Expected subscriptions array, got ${stringify(response.body)}`);
  }

  return response.body;
}

async function listDeliveries() {
  const response = await request('/deliveries');
  expectStatus(response, 200, 'GET /deliveries returns deliveries');

  if (!Array.isArray(response.body)) {
    throw new Error(`Expected deliveries array, got ${stringify(response.body)}`);
  }

  return response.body;
}

async function cleanupSubscriptions() {
  const wasSuppressingRequestMetrics = suppressRequestMetrics;
  suppressRequestMetrics = true;

  try {
    await Promise.all(
      subscriptionsToCleanup.map(([eventName, url]) =>
        request('/subscriptions', {
          method: 'DELETE',
          body: {
            eventName,
            url,
          },
          allowUnexpectedStatus: true,
        }),
      ),
    );
  } finally {
    suppressRequestMetrics = wasSuppressingRequestMetrics;
  }
}

async function waitForDeliveries(eventName, expectedUrls, expectedStatus) {
  await waitFor(async () => {
    const deliveries = await listDeliveries();
    const matchingDeliveries = latestDeliveriesFor(eventName, expectedUrls, deliveries);
    const missingUrls = expectedUrls.filter(
      (url) => !matchingDeliveries.some((delivery) => delivery.url === url),
    );

    if (missingUrls.length > 0) {
      return {
        done: false,
        detail: `missing deliveries for ${missingUrls.join(', ')}`,
      };
    }

    const failedDelivery = matchingDeliveries.find((delivery) => delivery.status === 'failed');

    if (failedDelivery) {
      throw new Error(`Delivery failed: ${stringify(failedDelivery)}`);
    }

    return {
      done: matchingDeliveries.every((delivery) => delivery.status === expectedStatus),
      detail: `current statuses are ${matchingDeliveries
        .map((delivery) => `${delivery.url}=${delivery.status}`)
        .join(', ')}`,
    };
  });
}

async function waitForDeliveryAttempt(eventName, url) {
  let deliveryWithAttempt = null;

  await waitFor(async () => {
    const deliveries = await listDeliveries();
    deliveryWithAttempt = deliveries
      .filter((delivery) => delivery.eventName === eventName && delivery.url === url)
      .find((delivery) => delivery.attempts >= 1 && delivery.lastError);

    return {
      done: Boolean(deliveryWithAttempt),
      detail: `waiting for a failed attempt for ${eventName} -> ${url}`,
    };
  });

  return deliveryWithAttempt;
}

async function request(path, options = {}) {
  return requestRaw(path, {
    method: options.method ?? 'GET',
    headers: options.body
      ? {
          'content-type': 'application/json',
        }
      : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    allowUnexpectedStatus: options.allowUnexpectedStatus,
  });
}

async function requestRaw(path, options = {}) {
  const method = options.method ?? 'GET';
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: options.headers,
    body: options.body,
  });
  const body = await readResponseBody(response);
  const durationMs = performance.now() - startedAt;

  if (!suppressRequestMetrics) {
    requestMetrics.push({
      testName: currentTestName,
      method,
      path: sanitizePath(path),
      status: response.status,
      durationMs,
    });
  }

  if (!options.allowUnexpectedStatus && response.status >= 500) {
    throw new Error(`${method} ${path} returned ${response.status}`);
  }

  return {
    status: response.status,
    body,
  };
}

async function readResponseBody(response) {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function waitFor(predicate) {
  const startedAt = Date.now();
  let lastDetail = 'condition was not met';

  while (Date.now() - startedAt < timeoutMs) {
    const result = await predicate();

    if (result.done) {
      return;
    }

    if (result.detail) {
      lastDetail = result.detail;
    }

    await delay(250);
  }

  throw new Error(`Timed out after ${timeoutMs}ms: ${lastDetail}`);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function expectStatus(response, expectedStatus, label) {
  check(
    response.status === expectedStatus,
    label,
    `expected ${expectedStatus}, got ${response.status}; body: ${stringify(response.body)}`,
  );
}

function expectErrorMessage(response, expectedMessage, label) {
  check(
    response.body?.error === expectedMessage,
    label,
    `expected ${expectedMessage}, got ${stringify(response.body)}`,
  );
}

function expectDeliveryCount(response, expectedCount, label) {
  check(
    hasDeliveryArray(response.body) && response.body.deliveries.length === expectedCount,
    label,
    `expected ${expectedCount} deliveries, got ${stringify(response.body)}`,
  );
}

function check(passed, label, failureDetail = '') {
  checks.push({
    passed,
    label,
    failureDetail,
    testName: currentTestName,
  });

  const marker = passed ? 'PASS' : 'FAIL';
  console.log(`${marker} ${label}`);

  if (!passed) {
    console.log(`     ${failureDetail}`);
    process.exitCode = 1;
  }
}

function printSummary() {
  const passed = checks.filter((checkResult) => checkResult.passed).length;
  const failed = checks.length - passed;
  const totalDurationMs = performance.now() - scriptStartedAt;
  const requestDurations = requestMetrics.map((requestMetric) => requestMetric.durationMs);

  console.log('\nSummary');
  console.log(`Base URL: ${baseUrl}`);
  console.log(`Run ID: ${runId}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total time: ${formatMs(totalDurationMs)}`);
  console.log(`HTTP requests: ${requestMetrics.length}`);
  console.log(`Average HTTP time: ${formatMs(average(requestDurations))}`);

  console.log('\nIntegration Test Results');
  console.table(
    testResults.map((result) => ({
      Test: result.name,
      Result: result.status,
      Checks: result.checks,
      Failed: result.failed,
      'Total Time': formatMs(result.durationMs),
      Requests: result.requestCount,
      'Avg HTTP': formatMs(result.averageRequestMs),
      'Slowest HTTP': formatMs(result.slowestRequestMs),
    })),
  );

  console.log('\nSlowest HTTP Requests');
  console.table(
    [...requestMetrics]
      .sort((left, right) => right.durationMs - left.durationMs)
      .slice(0, 10)
      .map((requestMetric) => ({
        Test: requestMetric.testName,
        Request: `${requestMetric.method} ${requestMetric.path}`,
        Status: requestMetric.status,
        Time: formatMs(requestMetric.durationMs),
      })),
  );

  if (failed === 0 && checks.length > 0 && process.exitCode !== 1) {
    console.log('Everything went well.');
  } else {
    console.log('Some checks failed.');
    process.exitCode = 1;
  }
}

function latestDeliveriesFor(eventName, urlsToFind, deliveries) {
  return urlsToFind
    .map((url) =>
      deliveries
        .filter((delivery) => delivery.eventName === eventName && delivery.url === url)
        .at(-1),
    )
    .filter(Boolean);
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, '');
}

function hasStringProperty(value, propertyName) {
  return (
    value !== null &&
    typeof value === 'object' &&
    propertyName in value &&
    typeof value[propertyName] === 'string'
  );
}

function hasDeliveryArray(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    'deliveries' in value &&
    Array.isArray(value.deliveries)
  );
}

function isIsoDateString(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function average(values) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function formatMs(value) {
  return `${value.toFixed(1)}ms`;
}

function sanitizePath(path) {
  return path.replace(runId, '<run-id>');
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stringify(value) {
  return JSON.stringify(value, null, 2);
}
