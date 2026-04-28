import { describe, expect, it, vi } from 'vitest';
import { calculateRetryDelayMs, isRetryableStatusCode } from '../src/delivery/retry.js';

describe('calculateRetryDelayMs', () => {
  it('returns zero before the first failed attempt', () => {
    const delay = calculateRetryDelayMs(0, {
      jitterRatio: 0,
    });

    expect(delay).toBe(0);
  });

  it('uses exponential backoff when jitter is disabled', () => {
    const firstDelay = calculateRetryDelayMs(1, {
      baseDelayMs: 100,
      jitterRatio: 0,
    });
    const secondDelay = calculateRetryDelayMs(2, {
      baseDelayMs: 100,
      jitterRatio: 0,
    });
    const thirdDelay = calculateRetryDelayMs(3, {
      baseDelayMs: 100,
      jitterRatio: 0,
    });

    expect(firstDelay).toBe(100);
    expect(secondDelay).toBe(200);
    expect(thirdDelay).toBe(400);
  });

  it('caps the delay at maxDelayMs', () => {
    const delay = calculateRetryDelayMs(10, {
      baseDelayMs: 100,
      maxDelayMs: 500,
      jitterRatio: 0,
    });

    expect(delay).toBe(500);
  });

  it('applies bounded jitter', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);

    const delay = calculateRetryDelayMs(1, {
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: 0.2,
    });

    expect(delay).toBe(120);
  });
});

describe('isRetryableStatusCode', () => {
  it('does not retry permanent client failures', () => {
    expect(isRetryableStatusCode(400)).toBe(false);
    expect(isRetryableStatusCode(401)).toBe(false);
    expect(isRetryableStatusCode(403)).toBe(false);
  });

  it('retries transient or unknown failures', () => {
    expect(isRetryableStatusCode(429)).toBe(true);
    expect(isRetryableStatusCode(500)).toBe(true);
    expect(isRetryableStatusCode(null)).toBe(true);
  });
});
