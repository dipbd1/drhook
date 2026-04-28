export class DrhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DrhookError';
  }
}

export class ValidationError extends DrhookError {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class DeliveryError extends DrhookError {
  readonly statusCode: number | null;

  constructor(message: string, statusCode: number | null = null) {
    super(message);
    this.name = 'DeliveryError';
    this.statusCode = statusCode;
  }
}
