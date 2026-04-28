export class DurableWebhooksError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DurableWebhooksError';
  }
}

export class ValidationError extends DurableWebhooksError {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class DeliveryError extends DurableWebhooksError {
  readonly statusCode: number | null;

  constructor(message: string, statusCode: number | null = null) {
    super(message);
    this.name = 'DeliveryError';
    this.statusCode = statusCode;
  }
}
