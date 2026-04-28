export interface RetryOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
}

const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 60_000;
const DEFAULT_JITTER_RATIO = 0.2;
const NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 403]);

export function calculateRetryDelayMs(attempts: number, options: RetryOptions = {}): number {
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;

  if (attempts <= 0) {
    return 0;
  }

  const exponent = attempts - 1;
  const exponentialDelayMs = baseDelayMs * 2 ** exponent;
  const cappedDelayMs = Math.min(exponentialDelayMs, maxDelayMs);

  if (jitterRatio <= 0) {
    return Math.round(cappedDelayMs);
  }

  const jitterAmountMs = cappedDelayMs * jitterRatio;
  const minimumDelayMs = cappedDelayMs - jitterAmountMs;
  const maximumDelayMs = cappedDelayMs + jitterAmountMs;
  const delayWithJitterMs = minimumDelayMs + Math.random() * (maximumDelayMs - minimumDelayMs);

  return Math.round(Math.min(delayWithJitterMs, maxDelayMs));
}

export function isRetryableStatusCode(statusCode: number | null): boolean {
  if (statusCode === null) {
    return true;
  }

  return !NON_RETRYABLE_STATUS_CODES.has(statusCode);
}
