#!/usr/bin/env node

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const testTimeoutMs = Number(process.env.TEST_TIMEOUT_MS ?? 15_000);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = join(scriptDirectory, '..', 'drhook');
const integrationScript = join(scriptDirectory, 'test-express-server.mjs');
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'drhook-express-integration-'));
const port = Number(process.env.PORT ?? (await getAvailablePort()));
const baseUrl = normalizeBaseUrl(process.env.BASE_URL ?? `http://127.0.0.1:${port}`);
const databaseUrl = process.env.WEBHOOK_DATABASE_URL ?? join(temporaryDirectory, 'webhooks.sqlite');

let serverProcess = null;
let isStoppingServer = false;

try {
  serverProcess = startServer();
  await waitForServer();
  await runIntegrationScript();
} finally {
  await stopServer();
  await rm(temporaryDirectory, {
    recursive: true,
    force: true,
  });
}

function startServer() {
  const child = spawn('npm', ['run', 'dev'], {
    cwd: packageDirectory,
    env: {
      ...process.env,
      PORT: String(port),
      BASE_URL: baseUrl,
      WEBHOOK_DATABASE_URL: databaseUrl,
    },
    stdio: 'inherit',
  });

  child.once('exit', (code, signal) => {
    if (isStoppingServer) {
      return;
    }

    if (code !== null && code !== 0) {
      console.error(`Express integration server exited with code ${code}.`);
    } else if (signal) {
      console.error(`Express integration server exited from signal ${signal}.`);
    }
  });

  return child;
}

async function waitForServer() {
  const startedAt = Date.now();
  let lastError = 'server did not respond';

  while (Date.now() - startedAt < testTimeoutMs) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`Server exited before it became ready with code ${serverProcess.exitCode}`);
    }

    try {
      const response = await fetch(`${baseUrl}/subscriptions`);

      if (response.ok) {
        return;
      }

      lastError = `readiness check returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await delay(250);
  }

  throw new Error(`Timed out waiting for Express server at ${baseUrl}: ${lastError}`);
}

async function runIntegrationScript() {
  const child = spawn(process.execPath, [integrationScript], {
    cwd: packageDirectory,
    env: {
      ...process.env,
      BASE_URL: baseUrl,
      TEST_TIMEOUT_MS: String(testTimeoutMs),
    },
    stdio: 'inherit',
  });

  const exitCode = await waitForExit(child);

  if (exitCode !== 0) {
    throw new Error(`Express integration test failed with exit code ${exitCode}`);
  }
}

async function stopServer() {
  if (!serverProcess || serverProcess.exitCode !== null) {
    return;
  }

  isStoppingServer = true;
  serverProcess.kill('SIGTERM');
  await waitForExit(serverProcess);
}

async function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        resolve(0);
        return;
      }

      resolve(code ?? 0);
    });
  });
}

async function getAvailablePort() {
  const server = createServer();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Expected an ephemeral TCP port');
  }

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  return address.port;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, '');
}
