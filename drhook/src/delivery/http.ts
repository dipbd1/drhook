import { DeliveryError } from '../errors.js';
import type { Delivery } from '../types.js';

export interface HttpDeliveryResult {
  statusCode: number;
}

export async function sendHttpDelivery(
  delivery: Delivery,
  timeoutMs: number,
): Promise<HttpDeliveryResult> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);

  try {
    const response = await fetch(delivery.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'drhook',
      },
      body: JSON.stringify({
        id: delivery.id,
        eventName: delivery.eventName,
        payload: delivery.payload,
      }),
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
