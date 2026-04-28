export type DeliveryStatus = 'pending' | 'in_progress' | 'succeeded' | 'failed';

export interface WebhooksConfig {
  databaseUrl: string;
  maxAttempts?: number;
  deliveryTimeoutMs?: number;
  pollIntervalMs?: number;
  batchSize?: number;
  deliveryConcurrency?: number;
  signingSecret?: string;
}

export interface Subscription {
  id: string;
  eventName: string;
  url: string;
  createdAt: Date;
}

export interface Delivery {
  id: string;
  eventName: string;
  payload: unknown;
  subscriptionId: string;
  url: string;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: Date;
  createdAt: Date;
  updatedAt: Date;
  lastError: string | null;
}

export interface DeliveryAttempt {
  id: string;
  deliveryId: string;
  statusCode: number | null;
  error: string | null;
  createdAt: Date;
}

export interface EmitOptions {
  id?: string;
}

export interface ReliableWebhooks {
  register(eventName: string, url: string): Promise<Subscription>;
  unregister(eventName: string, url: string): Promise<void>;
  emit(eventName: string, payload: unknown, options?: EmitOptions): Promise<Delivery[]>;
  start(): Promise<void>;
  stop(): Promise<void>;
  listSubscriptions(): Promise<Subscription[]>;
  listDeliveries(): Promise<Delivery[]>;
}
