/**
 * Notification channels, templates, and per-user preferences — issue #906.
 *
 * Defines the canonical notification channel and template enums and a store of
 * per-user, per-template channel opt-outs. By default every channel is enabled
 * for every template; users opt out of specific (template, channel) pairs (e.g.
 * no email for `payment_due`).
 *
 * The store is persisted in PostgreSQL (`notification_preferences`) so an
 * opt-out survives restarts and is shared by every instance (#1949). The
 * in-memory implementation is kept for tests and for runs without a database.
 */

import { getPool } from "../db.js";

export type NotificationChannel = "in_app" | "email" | "push";

export const ALL_CHANNELS: NotificationChannel[] = ["in_app", "email", "push"];

export type NotificationTemplate =
  | "deal_status_changed"
  | "payment_due"
  | "payment_received"
  | "payment_overdue"
  | "kyc_approved"
  | "kyc_rejected"
  | "lease_signing_requested"
  | "lease_fully_signed"
  | "dispute_filed"
  | "dispute_resolved"
  | "reward_validated"
  | "inspection_assigned"
  | "message_received";

export const NOTIFICATION_TEMPLATES: NotificationTemplate[] = [
  "deal_status_changed",
  "payment_due",
  "payment_received",
  "payment_overdue",
  "kyc_approved",
  "kyc_rejected",
  "lease_signing_requested",
  "lease_fully_signed",
  "dispute_filed",
  "dispute_resolved",
  "reward_validated",
  "inspection_assigned",
  "message_received",
];

/** A single opt-out: the user does not want `template` delivered on `channel`. */
export interface ChannelOptOut {
  template: NotificationTemplate;
  channel: NotificationChannel;
}

export interface NotificationPreferences {
  userId: string;
  optOuts: ChannelOptOut[];
}

export interface NotificationPreferenceStore {
  /** Returns the user's preferences (empty opt-out list when none stored). */
  get(userId: string): Promise<NotificationPreferences>;
  /** Is `channel` enabled for `template` for this user? Defaults to enabled. */
  isChannelEnabled(
    userId: string,
    template: NotificationTemplate,
    channel: NotificationChannel,
  ): Promise<boolean>;
  optOut(userId: string, template: NotificationTemplate, channel: NotificationChannel): Promise<void>;
  optIn(userId: string, template: NotificationTemplate, channel: NotificationChannel): Promise<void>;
  reset(userId?: string): Promise<void>;
}

export class InMemoryNotificationPreferenceStore implements NotificationPreferenceStore {
  private prefs = new Map<string, ChannelOptOut[]>();

  async get(userId: string): Promise<NotificationPreferences> {
    return { userId, optOuts: [...(this.prefs.get(userId) ?? [])] };
  }

  async isChannelEnabled(
    userId: string,
    template: NotificationTemplate,
    channel: NotificationChannel,
  ): Promise<boolean> {
    const optOuts = this.prefs.get(userId) ?? [];
    return !optOuts.some((o) => o.template === template && o.channel === channel);
  }

  async optOut(userId: string, template: NotificationTemplate, channel: NotificationChannel): Promise<void> {
    const optOuts = this.prefs.get(userId) ?? [];
    if (!optOuts.some((o) => o.template === template && o.channel === channel)) {
      optOuts.push({ template, channel });
    }
    this.prefs.set(userId, optOuts);
  }

  async optIn(userId: string, template: NotificationTemplate, channel: NotificationChannel): Promise<void> {
    const optOuts = (this.prefs.get(userId) ?? []).filter(
      (o) => !(o.template === template && o.channel === channel),
    );
    this.prefs.set(userId, optOuts);
  }

  async reset(userId?: string): Promise<void> {
    if (userId) this.prefs.delete(userId);
    else this.prefs.clear();
  }
}

/**
 * PostgreSQL implementation. A row holds the latest choice for one
 * (user, template, channel): `enabled = false` is an opt-out, `enabled = true`
 * an explicit opt-in. A missing row means the default (enabled).
 */
export class PostgresNotificationPreferenceStore implements NotificationPreferenceStore {
  async get(userId: string): Promise<NotificationPreferences> {
    const pool = await getPool();
    if (!pool) throw new Error("Database pool not initialized");
    const { rows } = await pool.query(
      `SELECT template, channel FROM notification_preferences
       WHERE user_id = $1 AND enabled = FALSE
       ORDER BY template, channel`,
      [userId],
    );
    return {
      userId,
      optOuts: rows.map((row) => ({
        template: row.template as NotificationTemplate,
        channel: row.channel as NotificationChannel,
      })),
    };
  }

  async isChannelEnabled(
    userId: string,
    template: NotificationTemplate,
    channel: NotificationChannel,
  ): Promise<boolean> {
    const pool = await getPool();
    if (!pool) throw new Error("Database pool not initialized");
    const { rows } = await pool.query(
      `SELECT enabled FROM notification_preferences
       WHERE user_id = $1 AND template = $2 AND channel = $3`,
      [userId, template, channel],
    );
    return rows.length === 0 || rows[0].enabled === true;
  }

  async optOut(userId: string, template: NotificationTemplate, channel: NotificationChannel): Promise<void> {
    await this.setEnabled(userId, template, channel, false);
  }

  async optIn(userId: string, template: NotificationTemplate, channel: NotificationChannel): Promise<void> {
    await this.setEnabled(userId, template, channel, true);
  }

  async reset(userId?: string): Promise<void> {
    const pool = await getPool();
    if (!pool) throw new Error("Database pool not initialized");
    if (userId) {
      await pool.query(`DELETE FROM notification_preferences WHERE user_id = $1`, [userId]);
    } else {
      await pool.query(`DELETE FROM notification_preferences`);
    }
  }

  private async setEnabled(
    userId: string,
    template: NotificationTemplate,
    channel: NotificationChannel,
    enabled: boolean,
  ): Promise<void> {
    const pool = await getPool();
    if (!pool) throw new Error("Database pool not initialized");
    await pool.query(
      `INSERT INTO notification_preferences (user_id, template, channel, enabled, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, template, channel)
       DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
      [userId, template, channel, enabled],
    );
  }
}

// Active backing store. Starts in-memory; the app swaps in Postgres at startup
// when DATABASE_URL is set (same pattern as the outbox store).
let _store: NotificationPreferenceStore = new InMemoryNotificationPreferenceStore();

export function initNotificationPreferenceStore(store: NotificationPreferenceStore): void {
  _store = store;
}

/**
 * Proxy that routes all calls to the active backing store.
 * Existing code that imports `notificationPreferenceStore` keeps working unchanged.
 */
export const notificationPreferenceStore: NotificationPreferenceStore = new Proxy(
  {} as NotificationPreferenceStore,
  {
    get(_target, prop) {
      return (_store as unknown as Record<string, unknown>)[prop as string];
    },
  },
);
