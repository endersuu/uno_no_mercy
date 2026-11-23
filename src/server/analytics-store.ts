import type { Client, InStatement } from "@libsql/client";

export const ANALYTICS_DAILY_SCHEMA = `CREATE TABLE IF NOT EXISTS analytics_daily (
  day TEXT NOT NULL,
  device_id TEXT NOT NULL,
  attribution_key TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  room_entered INTEGER NOT NULL DEFAULT 0,
  played INTEGER NOT NULL DEFAULT 0,
  identity_scope TEXT NOT NULL,
  browser TEXT NOT NULL,
  os TEXT NOT NULL,
  device_type TEXT NOT NULL,
  language TEXT,
  timezone TEXT,
  source TEXT,
  medium TEXT,
  campaign TEXT,
  referrer TEXT,
  PRIMARY KEY (day, device_id, attribution_key)
)`;

export async function ensureAnalyticsSchema(client: Pick<Client, "execute">) {
  await client.execute(ANALYTICS_DAILY_SCHEMA);
}

type Database = Pick<Client, "batch" | "execute" | "close">;
interface Daily {
  day: string;
  device_id: string;
  attribution_key: string;
  first_seen: string;
  last_seen: string;
  room_entered: number;
  played: number;
  identity_scope: string;
  browser: string;
  os: string;
  device_type: string;
  language: string | null;
  timezone: string | null;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  referrer: string | null;
}
export interface AnalyticsStoreOptions {
  flushIntervalMs?: number;
  batchSize?: number;
  maxPending?: number;
  now?: () => number;
  report?: (record: Record<string, unknown>) => void;
}

const metadataColumns = [
  "identity_scope",
  "browser",
  "os",
  "device_type",
  "language",
  "timezone",
] as const;
const columns: (keyof Daily)[] = [
  "day",
  "device_id",
  "attribution_key",
  "first_seen",
  "last_seen",
  "room_entered",
  "played",
  ...metadataColumns,
  "source",
  "medium",
  "campaign",
  "referrer",
];
// Tuple comparison makes metadata deterministic even when events share a timestamp.
const tuple = (table: string) =>
  `(${metadataColumns.map((column) => `coalesce(${table}.${column}, '')`).join(", ")})`;
const newer = `(excluded.last_seen > analytics_daily.last_seen OR
  (excluded.last_seen = analytics_daily.last_seen AND ${tuple("excluded")} > ${tuple("analytics_daily")}))`;
const upsert = `INSERT INTO analytics_daily (${columns.join(", ")})
  VALUES (${columns.map(() => "?").join(", ")})
  ON CONFLICT (day, device_id, attribution_key) DO UPDATE SET
    first_seen = min(analytics_daily.first_seen, excluded.first_seen),
    last_seen = max(analytics_daily.last_seen, excluded.last_seen),
    room_entered = max(analytics_daily.room_entered, excluded.room_entered),
    played = max(analytics_daily.played, excluded.played),
    ${metadataColumns.map((column) => `${column} = CASE WHEN ${newer} THEN excluded.${column} ELSE analytics_daily.${column} END`).join(",\n    ")}`;

function option(value: number | undefined, fallback: number, max: number) {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, max)
    : fallback;
}
function nullableText(value: unknown, max: number, pattern: RegExp) {
  return typeof value === "string" && value.length <= max && pattern.test(value)
    ? value
    : null;
}
function member(value: unknown, values: string[], fallback: string) {
  return typeof value === "string" && values.includes(value) ? value : fallback;
}
function rowFromEvent(event: unknown): Daily | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  if (
    e.kind !== "uno-analytics" ||
    e.schemaVersion !== 1 ||
    typeof e.event !== "string" ||
    ![
      "visitor_connected",
      "room_entered",
      "player_active",
      "visitor_disconnected",
    ].includes(e.event) ||
    typeof e.device_id !== "string" ||
    !/^[a-f0-9]{64}$/.test(e.device_id) ||
    typeof e.at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(e.at)
  )
    return null;
  const milliseconds = Date.parse(e.at);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== e.at
  )
    return null;
  const source = nullableText(e.source, 80, /^[a-z0-9_.~ -]+$/i);
  const medium = nullableText(e.medium, 80, /^[a-z0-9_.~ -]+$/i);
  const campaign = nullableText(e.campaign, 80, /^[a-z0-9_.~ -]+$/i);
  let referrer = nullableText(e.referrer, 253, /^[a-z0-9.\[\]:-]+$/i);
  if (referrer) {
    try {
      if (new URL(`https://${referrer}`).hostname !== referrer.toLowerCase())
        referrer = null;
    } catch {
      referrer = null;
    }
  }
  let timezone = nullableText(e.timezone, 80, /^[a-z0-9_+:/-]+$/i);
  if (timezone) {
    try {
      timezone = new Intl.DateTimeFormat("en", {
        timeZone: timezone,
      }).resolvedOptions().timeZone;
    } catch {
      timezone = null;
    }
  }
  return {
    day: e.at.slice(0, 10),
    device_id: e.device_id,
    attribution_key: JSON.stringify([source, medium, campaign, referrer]),
    first_seen: e.at,
    last_seen: e.at,
    room_entered: e.event === "room_entered" ? 1 : 0,
    played: e.event === "player_active" ? 1 : 0,
    identity_scope: member(
      e.identity_scope,
      ["persistent", "ephemeral", "connection"],
      "connection",
    ),
    browser: member(
      e.browser,
      ["Edge", "Opera", "Firefox", "Chrome", "Safari", "unknown"],
      "unknown",
    ),
    os: member(
      e.os,
      ["iOS", "Android", "Windows", "Chrome OS", "macOS", "Linux", "unknown"],
      "unknown",
    ),
    device_type: member(
      e.device_type,
      ["mobile", "tablet", "desktop", "unknown"],
      "unknown",
    ),
    language: nullableText(e.language, 64, /^[a-z]{2,8}(-[a-z0-9]{1,8})*$/i),
    timezone,
    source,
    medium,
    campaign,
    referrer,
  };
}
function merge(a: Daily, b: Daily): Daily {
  const aMetadata = metadataColumns.map((column) => a[column] ?? "").join("\0");
  const bMetadata = metadataColumns.map((column) => b[column] ?? "").join("\0");
  const latest =
    b.last_seen > a.last_seen ||
    (b.last_seen === a.last_seen && bMetadata > aMetadata)
      ? b
      : a;
  return {
    ...latest,
    first_seen: a.first_seen < b.first_seen ? a.first_seen : b.first_seen,
    last_seen: a.last_seen > b.last_seen ? a.last_seen : b.last_seen,
    room_entered: Math.max(a.room_entered, b.room_entered),
    played: Math.max(a.played, b.played),
  };
}

/** Bounded write-behind buffer; gameplay never waits for database requests. */
export class AnalyticsStore {
  private pending = new Map<string, Daily>();
  private inFlight: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private schemaReady = false;
  private accepting = true;
  private closed = false;
  private closing: Promise<boolean> | null = null;
  private nextAttempt = 0;
  private consecutiveFailures = 0;
  private failures = 0;
  private dropped = 0;
  private lastReport = new Map<string, number>();
  private batchSize: number;
  private maxPending: number;
  private now: () => number;
  private report: (record: Record<string, unknown>) => void;

  constructor(
    private client: Database,
    options: AnalyticsStoreOptions = {},
  ) {
    this.batchSize = option(options.batchSize, 100, 500);
    this.maxPending = option(options.maxPending, 5000, 50_000);
    this.now = options.now ?? Date.now;
    this.report =
      options.report ?? ((record) => console.log(JSON.stringify(record)));
    if (options.flushIntervalMs !== 0) {
      this.timer = setInterval(
        () => {
          void this.flush();
        },
        option(options.flushIntervalMs, 5000, 60_000),
      );
      this.timer.unref();
    }
  }

  get pendingCount() {
    return this.pending.size;
  }

  enqueue(event: unknown): void {
    if (!this.accepting) return;
    const row = rowFromEvent(event);
    if (!row) return;
    const key = `${row.day}:${row.device_id}:${row.attribution_key}`;
    const existing = this.pending.get(key);
    if (existing) this.pending.set(key, merge(existing, row));
    else if (this.pending.size < this.maxPending) this.pending.set(key, row);
    else {
      this.dropped++;
      this.status("overflow");
    }
  }

  flush(): Promise<boolean> {
    return this.flushOnce(false);
  }

  private flushOnce(force: boolean): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    if (this.closed) return Promise.resolve(this.pending.size === 0);
    if (!force && this.now() < this.nextAttempt) return Promise.resolve(false);
    this.inFlight = this.writeBatch().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async writeBatch(): Promise<boolean> {
    try {
      if (!this.schemaReady) {
        await ensureAnalyticsSchema(this.client);
        this.schemaReady = true;
        this.status("ready", true);
      }
      const entries = [...this.pending.entries()].slice(0, this.batchSize);
      if (entries.length) {
        const statements: InStatement[] = entries.map(([, row]) => ({
          sql: upsert,
          args: columns.map((column) => row[column]),
        }));
        await this.client.batch(statements, "write");
        for (const [key, row] of entries) {
          // An event received during the write remains queued for another upsert.
          if (this.pending.get(key) === row) this.pending.delete(key);
        }
      }
      this.consecutiveFailures = 0;
      this.nextAttempt = 0;
      return true;
    } catch {
      this.failures++;
      this.consecutiveFailures++;
      const retryMs = Math.min(
        60_000,
        1000 * 2 ** Math.min(6, this.consecutiveFailures - 1),
      );
      this.nextAttempt = this.now() + retryMs;
      this.status("retry", false, { retry_in_ms: retryMs });
      return false;
    }
  }

  /** At most one request in flight; the caller's fetch timeout bounds each await. */
  close(): Promise<boolean> {
    if (this.closing) return this.closing;
    this.accepting = false;
    clearInterval(this.timer);
    this.closing = (async () => {
      const deadline = performance.now() + 5000;
      let ok = this.inFlight ? await this.inFlight : true;
      while (ok && this.pending.size && performance.now() < deadline)
        ok = await this.flushOnce(true);
      const drained = this.pending.size === 0;
      this.closed = true;
      try {
        this.client.close();
      } catch {
        /* No secrets from driver exceptions. */
      }
      this.status("closed", true, { drained });
      return drained;
    })();
    return this.closing;
  }

  private status(
    event: string,
    force = false,
    extra: Record<string, unknown> = {},
  ) {
    const now = this.now();
    const last = this.lastReport.get(event);
    if (!force && last !== undefined && now - last < 30_000) return;
    this.lastReport.set(event, now);
    try {
      this.report({
        kind: "uno-analytics-storage",
        event,
        pending_rows: this.pending.size,
        failures: this.failures,
        dropped_events: this.dropped,
        ...extra,
      });
    } catch {
      /* Status reporting must not break gameplay or flushes. */
    }
  }
}
