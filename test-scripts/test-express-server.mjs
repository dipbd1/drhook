#!/usr/bin/env node

const baseUrl = normalizeBaseUrl(process.env.BASE_URL ?? process.argv[2] ?? 'http://localhost:3000');
const eventName = `test.script.${Date.now()}`;
const receiverUrl = `${baseUrl}/demo-receiver`;
const timeoutMs = Number(process.env.TEST_TIMEOUT_MS ?? 10_000);

const checks = [];

try {
  await cleanupSubscription();

  const missingFieldsResponse = await request('/subscriptions', {
    method: 'POST',
    body: {
      eventName,
    },
  });
  check(
    missingFieldsResponse.status === 400,
    'POST /subscriptions rejects missing url',
    `expected 400, got ${missingFieldsResponse.status}`,
  );

  const subscriptionResponse = await request('/subscriptions', {
    method: 'POST',
    body: {
      eventName,
      url: receiverUrl,
    },
  });
  check(
    subscriptionResponse.status === 201,
    'POST /subscriptions creates a subscription',
    `expected 201, got ${subscriptionResponse.status}`,
  );
  check(
    hasStringProperty(subscriptionResponse.body, 'id') &&
      subscriptionResponse.body.eventName === eventName &&
      subscriptionResponse.body.url === receiverUrl,
    'created subscription has expected fields',
    `unexpected body: ${JSON.stringify(subscriptionResponse.body)}`,
  );

  const subscriptionsResponse = await request('/subscriptions');
  check(
    subscriptionsResponse.status === 200,
    'GET /subscriptions returns subscriptions',
    `expected 200, got ${subscriptionsResponse.status}`,
  );
  check(
    Array.isArray(subscriptionsResponse.body) &&
      subscriptionsResponse.body.some(
        (subscription) =>
          subscription.eventName === eventName && subscription.url === receiverUrl,
      ),
    'created subscription appears in subscription list',
    `unexpected body: ${JSON.stringify(subscriptionsResponse.body)}`,
  );

  const eventResponse = await request(`/events/${encodeURIComponent(eventName)}`, {
    method: 'POST',
    body: {
      testRun: eventName,
      createdAt: new Date().toISOString(),
    },
  });
  check(
    eventResponse.status === 202,
    'POST /events/:eventName queues a delivery',
    `expected 202, got ${eventResponse.status}`,
  );
  check(
    hasDeliveryArray(eventResponse.body) && eventResponse.body.deliveries.length === 1,
    'event response includes one delivery',
    `unexpected body: ${JSON.stringify(eventResponse.body)}`,
  );

  await waitForSuccessfulDelivery();

  const deleteResponse = await request('/subscriptions', {
    method: 'DELETE',
    body: {
      eventName,
      url: receiverUrl,
    },
  });
  check(
    deleteResponse.status === 204,
    'DELETE /subscriptions removes the subscription',
    `expected 204, got ${deleteResponse.status}`,
  );

  printSummary();
} catch (error) {
  console.error('\nTest script failed before all checks could run.');
  console.error(error instanceof Error ? error.message : error);
  printSummary();
  process.exitCode = 1;
}

async function cleanupSubscription() {
  await request('/subscriptions', {
    method: 'DELETE',
    body: {
      eventName,
      url: receiverUrl,
    },
    allowUnexpectedStatus: true,
  });
}

async function waitForSuccessfulDelivery() {
  await waitFor(async () => {
    const response = await request('/deliveries');

    if (response.status !== 200 || !Array.isArray(response.body)) {
      return {
        done: false,
      };
    }

    const delivery = response.body.find(
      (candidate) => candidate.eventName === eventName && candidate.url === receiverUrl,
    );

    if (!delivery) {
      return {
        done: false,
      };
    }

    if (delivery.status === 'failed') {
      throw new Error(`Delivery failed: ${delivery.lastError ?? 'unknown error'}`);
    }

    return {
      done: delivery.status === 'succeeded',
      detail: `current status is ${delivery.status}`,
    };
  });

  check(true, 'queued delivery reaches succeeded status');
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: options.body
      ? {
          'content-type': 'application/json',
        }
      : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const body = await readResponseBody(response);

  if (!options.allowUnexpectedStatus && response.status >= 500) {
    throw new Error(`${options.method ?? 'GET'} ${path} returned ${response.status}`);
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

function check(passed, label, failureDetail = '') {
  checks.push({
    passed,
    label,
    failureDetail,
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

  console.log('\nSummary');
  console.log(`Base URL: ${baseUrl}`);
  console.log(`Event name: ${eventName}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed === 0 && checks.length > 0) {
    console.log('Everything went well.');
  } else {
    console.log('Some checks failed.');
    process.exitCode = 1;
  }
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
