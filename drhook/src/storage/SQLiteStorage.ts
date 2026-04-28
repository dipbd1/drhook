import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Database as DatabaseConnection } from 'better-sqlite3';
import type { Delivery, DeliveryStatus, Subscription } from '../types.js';
import type {
  CreateDeliveryInput,
  DeliveryFailureInput,
  StorageAdapter,
} from './StorageAdapter.js';

interface SubscriptionRow {
  id: string;
  event_name: string;
  url: string;
  created_at: string;
}

interface DeliveryRow {
  id: string;
  event_name: string;
  payload_json: string;
  subscription_id: string;
  url: string;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: string;
  created_at: string;
  updated_at: string;
  last_error: string | null;
}

export class SQLiteStorage implements StorageAdapter {
  private readonly database: DatabaseConnection;
  private isClosed = false;

  constructor(databaseUrl: string) {
    if (databaseUrl !== ':memory:') {
      const directory = dirname(databaseUrl);

      if (directory !== '.') {
        mkdirSync(directory, { recursive: true });
      }
    }

    this.database = new Database(databaseUrl);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('foreign_keys = ON');
  }

  async initialize(): Promise<void> {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        event_name TEXT NOT NULL,
        url TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(event_name, url)
      );

      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        event_name TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        subscription_id TEXT NOT NULL,
        url TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'in_progress', 'succeeded', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT,
        FOREIGN KEY(subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS delivery_attempts (
        id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL,
        status_code INTEGER,
        error TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(delivery_id) REFERENCES deliveries(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_subscriptions_event_name ON subscriptions(event_name);
      CREATE INDEX IF NOT EXISTS idx_deliveries_due ON deliveries(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_delivery_attempts_delivery_id ON delivery_attempts(delivery_id);
    `);
  }

  async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }

    this.database.close();
    this.isClosed = true;
  }

  async resetInProgressDeliveries(): Promise<void> {
    const now = toDatabaseDate(new Date());

    this.database
      .prepare(
        `
          UPDATE deliveries
          SET status = 'pending', updated_at = ?
          WHERE status = 'in_progress'
        `,
      )
      .run(now);
  }

  async registerSubscription(eventName: string, url: string): Promise<Subscription> {
    const id = randomUUID();
    const now = toDatabaseDate(new Date());

    this.database
      .prepare(
        `
          INSERT INTO subscriptions (id, event_name, url, created_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(event_name, url) DO NOTHING
        `,
      )
      .run(id, eventName, url, now);

    const row = this.database
      .prepare('SELECT * FROM subscriptions WHERE event_name = ? AND url = ?')
      .get(eventName, url) as SubscriptionRow;

    return mapSubscription(row);
  }

  async unregisterSubscription(eventName: string, url: string): Promise<void> {
    this.database
      .prepare('DELETE FROM subscriptions WHERE event_name = ? AND url = ?')
      .run(eventName, url);
  }

  async listSubscriptions(eventName?: string): Promise<Subscription[]> {
    let rows: SubscriptionRow[];

    if (eventName) {
      rows = this.database
        .prepare('SELECT * FROM subscriptions WHERE event_name = ? ORDER BY created_at ASC')
        .all(eventName) as SubscriptionRow[];
    } else {
      rows = this.database
        .prepare('SELECT * FROM subscriptions ORDER BY event_name ASC, created_at ASC')
        .all() as SubscriptionRow[];
    }

    return rows.map(mapSubscription);
  }

  async createDeliveries(inputs: CreateDeliveryInput[]): Promise<Delivery[]> {
    if (inputs.length === 0) {
      return [];
    }

    const now = toDatabaseDate(new Date());
    const insertDelivery = this.database.prepare(`
      INSERT INTO deliveries (
        id,
        event_name,
        payload_json,
        subscription_id,
        url,
        status,
        attempts,
        next_attempt_at,
        created_at,
        updated_at,
        last_error
      )
      VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, NULL)
    `);

    const createdRows: DeliveryRow[] = [];
    const transaction = this.database.transaction(() => {
      for (const input of inputs) {
        const id = randomUUID();
        const payloadJson = JSON.stringify(input.payload);

        insertDelivery.run(
          id,
          input.eventName,
          payloadJson,
          input.subscriptionId,
          input.url,
          now,
          now,
          now,
        );

        const row = this.database.prepare('SELECT * FROM deliveries WHERE id = ?').get(id) as DeliveryRow;
        createdRows.push(row);
      }
    });

    transaction();

    return createdRows.map(mapDelivery);
  }

  async listDeliveries(): Promise<Delivery[]> {
    const rows = this.database
      .prepare('SELECT * FROM deliveries ORDER BY created_at ASC')
      .all() as DeliveryRow[];

    return rows.map(mapDelivery);
  }

  async fetchDueDeliveries(limit: number, now: Date): Promise<Delivery[]> {
    const rows = this.database
      .prepare(
        `
          SELECT *
          FROM deliveries
          WHERE status = 'pending' AND next_attempt_at <= ?
          ORDER BY next_attempt_at ASC, created_at ASC
          LIMIT ?
        `,
      )
      .all(toDatabaseDate(now), limit) as DeliveryRow[];

    return rows.map(mapDelivery);
  }

  async markDeliveryInProgress(deliveryId: string): Promise<Delivery | null> {
    const now = toDatabaseDate(new Date());

    const result = this.database
      .prepare(
        `
          UPDATE deliveries
          SET status = 'in_progress', updated_at = ?
          WHERE id = ? AND status = 'pending'
        `,
      )
      .run(now, deliveryId);

    if (result.changes === 0) {
      return null;
    }

    const row = this.database.prepare('SELECT * FROM deliveries WHERE id = ?').get(deliveryId) as
      | DeliveryRow
      | undefined;

    if (!row) {
      return null;
    }

    return mapDelivery(row);
  }

  async recordDeliverySuccess(deliveryId: string, statusCode: number | null): Promise<void> {
    const now = toDatabaseDate(new Date());

    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `
            UPDATE deliveries
            SET status = 'succeeded', updated_at = ?, last_error = NULL
            WHERE id = ?
          `,
        )
        .run(now, deliveryId);

      insertAttempt(this.database, deliveryId, statusCode, null, now);
    });

    transaction();
  }

  async recordDeliveryFailure(input: DeliveryFailureInput): Promise<void> {
    const now = toDatabaseDate(new Date());
    const nextAttemptAt = input.nextAttemptAt ? toDatabaseDate(input.nextAttemptAt) : now;

    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `
            UPDATE deliveries
            SET status = ?, attempts = ?, next_attempt_at = ?, updated_at = ?, last_error = ?
            WHERE id = ?
          `,
        )
        .run(input.finalStatus, input.attempts, nextAttemptAt, now, input.error, input.deliveryId);

      insertAttempt(this.database, input.deliveryId, input.statusCode, input.error, now);
    });

    transaction();
  }
}

function insertAttempt(
  database: DatabaseConnection,
  deliveryId: string,
  statusCode: number | null,
  error: string | null,
  createdAt: string,
): void {
  database
    .prepare(
      `
        INSERT INTO delivery_attempts (id, delivery_id, status_code, error, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
    )
    .run(randomUUID(), deliveryId, statusCode, error, createdAt);
}

function mapSubscription(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    eventName: row.event_name,
    url: row.url,
    createdAt: new Date(row.created_at),
  };
}

function mapDelivery(row: DeliveryRow): Delivery {
  return {
    id: row.id,
    eventName: row.event_name,
    payload: JSON.parse(row.payload_json) as unknown,
    subscriptionId: row.subscription_id,
    url: row.url,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: new Date(row.next_attempt_at),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    lastError: row.last_error,
  };
}

function toDatabaseDate(date: Date): string {
  return date.toISOString();
}
