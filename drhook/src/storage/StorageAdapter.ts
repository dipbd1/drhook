import type { Delivery, DeliveryStatus, Subscription } from '../types.js';

export interface CreateDeliveryInput {
  eventName: string;
  payload: unknown;
  subscriptionId: string;
  url: string;
}

export interface DeliveryFailureInput {
  deliveryId: string;
  statusCode: number | null;
  error: string;
  attempts: number;
  nextAttemptAt: Date | null;
  finalStatus: DeliveryStatus;
}

export interface StorageAdapter {
  initialize(): Promise<void>;
  close(): Promise<void>;
  resetInProgressDeliveries(): Promise<void>;
  registerSubscription(eventName: string, url: string): Promise<Subscription>;
  unregisterSubscription(eventName: string, url: string): Promise<void>;
  listSubscriptions(eventName?: string): Promise<Subscription[]>;
  createDeliveries(inputs: CreateDeliveryInput[]): Promise<Delivery[]>;
  listDeliveries(): Promise<Delivery[]>;
  fetchDueDeliveries(limit: number, now: Date): Promise<Delivery[]>;
  markDeliveryInProgress(deliveryId: string): Promise<Delivery | null>;
  recordDeliverySuccess(deliveryId: string, statusCode: number | null): Promise<void>;
  recordDeliveryFailure(input: DeliveryFailureInput): Promise<void>;
}
