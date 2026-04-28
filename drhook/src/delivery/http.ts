import { createHmac } from 'node:crypto';
import { DeliveryError } from '../errors.js';
import type { Delivery } from '../types.js';

export interface HttpDeliveryResult {
  statusCode: number;
}

export async function sendHttpDelivery(
  delivery: Delivery,
  timeoutMs: number,
  signingSecret?: string,
): Promise<HttpDeliveryResult> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);
  const body = JSON.stringify({
    id: delivery.id,
    eventName: delivery.eventName,
    payload: delivery.payload,
  });
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'drhook',
  };

  if (signingSecret) {
    Object.assign(headers, createSignatureHeaders(body, signingSecret));
  }

  try {
    const response = await fetch(delivery.url, {
      method: 'POST',
      headers,
      body,
      signal: abortController.signal,
    });

    if (response.ok) {
      return {
        statusCode: response.status,
      };
    }

    throw new DeliveryError(`Webhook returned HTTP ${response.status}`, response.status);
  } catch (error) {
    if (error instanceof DeliveryError) {
      throw error;
    }

    if (error instanceof Error) {
      throw new DeliveryError(error.message);
    }

    throw new DeliveryError('Webhook delivery failed');
  } finally {
    clearTimeout(timeout);
  }
}

function createSignatureHeaders(body: string, signingSecret: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const signature = createHmac('sha256', signingSecret)
    .update(`${timestamp}.${body}`)
    .digest('hex');

  return {
    'x-drhook-signature': `sha256=${signature}`,
    'x-drhook-timestamp': timestamp,
  };
}
