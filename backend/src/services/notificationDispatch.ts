/**
 * Unified notification dispatch — issue #906.
 *
 * Routes a notification to the effective set of channels (after applying the
 * user's preferences) and delivers it through injectable channel adapters,
 * retrying transient failures with exponential back-off (max 3 attempts)
 * before marking a channel `failed`.
 *
 * Adapters are injected so this is unit-testable with stub transports; the
 * real Email/InApp/Push adapters plug in at the call site.
 */

import {
  ALL_CHANNELS,
  type NotificationChannel,
  type NotificationTemplate,
  type NotificationPreferenceStore,
  notificationPreferenceStore,
} from "../models/notificationPreferenceStore.js";

export const MAX_DELIVERY_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;
const BACKOFF_FACTOR = 2;

/** Exponential back-off (ms) before the Nth retry. attempt is 1-based. */
export function computeBackoffMs(
  attempt: number,
  baseMs: number = BASE_BACKOFF_MS,
  factor: number = BACKOFF_FACTOR,
): number {
  const n = Math.max(1, attempt);
  return baseMs * Math.pow(factor, n - 1);
}

/**
 * Resolve which channels a notification should actually be sent on: the
 * requested channels (or all channels by default), minus any the user has
 * opted out of for this template.
 */
export async function resolveChannels(
  userId: string,
  template: NotificationTemplate,
  requested: NotificationChannel[] | undefined,
  store: NotificationPreferenceStore = notificationPreferenceStore,
): Promise<NotificationChannel[]> {
  const candidates = requested && requested.length > 0 ? requested : ALL_CHANNELS;
  // De-duplicate while preserving order.
  const unique = Array.from(new Set(candidates));
  const enabled = await Promise.all(
    unique.map((channel) => store.isChannelEnabled(userId, template, channel)),
  );
  return unique.filter((_channel, index) => enabled[index]);
}

export type ChannelDeliveryStatus = "delivered" | "failed" | "skipped";

export interface ChannelResult {
  channel: NotificationChannel;
  status: ChannelDeliveryStatus;
  attempts: number;
  error?: string;
}

export interface DispatchResult {
  userId: string;
  template: NotificationTemplate;
  results: ChannelResult[];
  /** True when every resolved channel was delivered. */
  delivered: boolean;
}

/** A channel transport. Throwing signals a (possibly transient) delivery failure. */
export type ChannelAdapter = (input: {
  userId: string;
  template: NotificationTemplate;
  data: Record<string, unknown>;
}) => Promise<void>;

export interface DispatchOptions {
  channels?: NotificationChannel[];
  store?: NotificationPreferenceStore;
  maxAttempts?: number;
  /** Injectable delay (defaults to a real timer); tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Dispatch a notification across its resolved channels. Each channel is tried
 * up to `maxAttempts` times with exponential back-off; a channel the user has
 * opted out of is never attempted.
 */
export async function dispatchNotification(
  userId: string,
  template: NotificationTemplate,
  data: Record<string, unknown>,
  adapters: Partial<Record<NotificationChannel, ChannelAdapter>>,
  options: DispatchOptions = {},
): Promise<DispatchResult> {
  const store = options.store ?? notificationPreferenceStore;
  const maxAttempts = options.maxAttempts ?? MAX_DELIVERY_ATTEMPTS;
  const sleep = options.sleep ?? realSleep;

  const channels = await resolveChannels(userId, template, options.channels, store);
  const results: ChannelResult[] = [];

  for (const channel of channels) {
    const adapter = adapters[channel];
    if (!adapter) {
      results.push({ channel, status: "skipped", attempts: 0, error: "no adapter" });
      continue;
    }

    let attempts = 0;
    let lastError: string | undefined;
    let delivered = false;

    while (attempts < maxAttempts) {
      attempts += 1;
      try {
        await adapter({ userId, template, data });
        delivered = true;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempts < maxAttempts) {
          await sleep(computeBackoffMs(attempts));
        }
      }
    }

    results.push(
      delivered
        ? { channel, status: "delivered", attempts }
        : { channel, status: "failed", attempts, error: lastError },
    );
  }

  const deliverable = results.filter((r) => r.status !== "skipped");
  const delivered = deliverable.length > 0 && deliverable.every((r) => r.status === "delivered");

  return { userId, template, results, delivered };
}
