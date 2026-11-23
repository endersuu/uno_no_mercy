import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createClient,
  type Client,
  type InStatement,
  type ResultSet,
} from "@libsql/client";
import {
  AnalyticsStore,
  ensureAnalyticsSchema,
} from "../src/server/analytics-store.js";

function event(overrides: Record<string, unknown> = {}) {
  return {
    kind: "uno-analytics",
    schemaVersion: 1,
    event: "visitor_connected",
    at: "2026-11-23T12:00:00.000Z",
    device_id: "a".repeat(64),
    identity_scope: "persistent",
    browser: "Chrome",
    os: "Windows",
    device_type: "desktop",
    language: "zh-CN",
    timezone: "Asia/Shanghai",
    source: "social",
    medium: "link",
    campaign: "launch",
    referrer: "example.com",
    ...overrides,
  };
}
const quiet = () => {};
const empty: ResultSet = {
  columns: [],
  columnTypes: [],
  rows: [],
  rowsAffected: 0,
  lastInsertRowid: undefined,
  toJSON: () => ({}),
};
function fake(
  overrides: Partial<Pick<Client, "batch" | "execute" | "close">> = {},
) {
  return {
    execute: async () => empty,
    batch: async () => [],
    close: quiet,
    ...overrides,
  } as Pick<Client, "batch" | "execute" | "close">;
}

test("Turso daily rows persist across clients, deduplicate retries, and merge reordered events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uno-analytics-store-"));
  const url = `file:${join(dir, "analytics.db")}`;
  const client = createClient({ url });
  const store = new AnalyticsStore(client, {
    flushIntervalMs: 0,
    report: quiet,
  });
  try {
    // Initialization succeeds even when no player has connected yet.
    assert.equal(await store.flush(), true);
    await ensureAnalyticsSchema(client);
    store.enqueue(
      event({
        token: "secret-token",
        name: "private-name",
        network_ip: "192.0.2.123",
        connection_id: "secret-socket",
      }),
    );
    store.enqueue(event({ event: "room_entered" }));
    assert.equal(store.pendingCount, 1);
    assert.equal(await store.flush(), true);
    // A delayed event sets played and extends first_seen without replacing newer metadata.
    store.enqueue(
      event({
        event: "player_active",
        at: "2026-11-23T11:00:00.000Z",
        browser: "Firefox",
      }),
    );
    await store.flush();
    store.enqueue(event());
    store.enqueue(
      event({ at: "2026-11-23T13:00:00.000Z", browser: "Safari", os: "macOS" }),
    );
    await store.flush();
    const result = await client.execute("SELECT * FROM analytics_daily");
    assert.equal(result.rows.length, 1);
    const row = result.rows[0];
    assert.equal(row.first_seen, "2026-11-23T11:00:00.000Z");
    assert.equal(row.last_seen, "2026-11-23T13:00:00.000Z");
    assert.equal(row.browser, "Safari");
    assert.equal(row.os, "macOS");
    assert.equal(row.room_entered, 1);
    assert.equal(row.played, 1);
    assert.equal(
      row.attribution_key,
      JSON.stringify(["social", "link", "launch", "example.com"]),
    );
    const persisted = JSON.stringify(result);
    for (const secret of [
      "secret-token",
      "private-name",
      "192.0.2.123",
      "secret-socket",
    ])
      assert.ok(!persisted.includes(secret));
    for (const forbidden of [
      "token",
      "name",
      "network_ip",
      "connection_id",
      "room_id",
      "round_id",
    ])
      assert.ok(!result.columns.includes(forbidden));
    store.enqueue(event({ source: "newsletter" }));
    store.enqueue(
      event({ event: "player_active", at: "2026-11-24T00:00:00.000Z" }),
    );
    assert.equal(await store.close(), true);
    const reopened = createClient({ url });
    try {
      const counts = await reopened.execute(
        "SELECT count(*) AS rows, count(DISTINCT device_id) AS devices, count(DISTINCT day) AS days FROM analytics_daily",
      );
      assert.equal(counts.rows[0].rows, 3);
      assert.equal(counts.rows[0].devices, 1);
      assert.equal(counts.rows[0].days, 2);
    } finally {
      reopened.close();
    }
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("same-time metadata ties are deterministic in memory and SQL regardless of arrival order", async () => {
  const client = createClient({ url: "file::memory:" });
  const store = new AnalyticsStore(client, {
    flushIntervalMs: 0,
    report: quiet,
  });
  try {
    store.enqueue(event({ device_id: "a".repeat(64), browser: "Safari" }));
    store.enqueue(event({ device_id: "a".repeat(64), browser: "Chrome" }));
    store.enqueue(event({ device_id: "b".repeat(64), browser: "Chrome" }));
    await store.flush();
    store.enqueue(event({ device_id: "b".repeat(64), browser: "Safari" }));
    store.enqueue(event({ device_id: "a".repeat(64), browser: "Chrome" }));
    await store.flush();
    const rows = (await client.execute("SELECT browser FROM analytics_daily"))
      .rows;
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.browser === "Safari"));
  } finally {
    await store.close();
  }
});

test("invalid events are ignored and untrusted extra fields never enter SQL arguments", async () => {
  const batches: InStatement[][] = [];
  const store = new AnalyticsStore(
    fake({
      batch: async (statements) => {
        batches.push(statements as InStatement[]);
        return [];
      },
    }),
    { flushIntervalMs: 0, report: quiet },
  );
  for (const invalid of [
    null,
    [],
    "bad",
    event({ kind: "other" }),
    event({ device_id: "device-raw-secret" }),
    event({ at: "2026-02-30T12:00:00.000Z" }),
    event({ event: "credential" }),
  ])
    store.enqueue(invalid);
  assert.equal(store.pendingCount, 0);
  store.enqueue(
    event({
      source: "bad\nsource",
      referrer: "example.com/private?token=secret",
      browser: "raw-UA-secret",
      timezone: "not-a-zone",
      token: "private-token",
    }),
  );
  assert.equal(await store.flush(), true);
  const sqlInput = JSON.stringify(batches);
  for (const secret of [
    "bad\\nsource",
    "token=secret",
    "raw-UA-secret",
    "not-a-zone",
    "private-token",
  ])
    assert.ok(!sqlInput.includes(secret));
  await store.close();
});

test("failed requests retain merges, back off, and cannot expose driver credentials in status logs", async () => {
  let now = 0,
    attempts = 0;
  const reports: Record<string, unknown>[] = [];
  const store = new AnalyticsStore(
    fake({
      batch: async () => {
        attempts++;
        if (attempts < 3)
          throw Error("https://secret-token@private-turso.example");
        return [];
      },
    }),
    {
      flushIntervalMs: 0,
      now: () => now,
      report: (record) => reports.push(record),
    },
  );
  store.enqueue(event());
  assert.equal(await store.flush(), false);
  store.enqueue(event({ event: "player_active" }));
  assert.equal(store.pendingCount, 1);
  assert.equal(await store.flush(), false);
  assert.equal(attempts, 1);
  now = 1000;
  assert.equal(await store.flush(), false);
  now = 2999;
  assert.equal(await store.flush(), false);
  assert.equal(attempts, 2);
  now = 3000;
  assert.equal(await store.flush(), true);
  assert.equal(store.pendingCount, 0);
  assert.equal(reports.filter((record) => record.event === "retry").length, 1);
  assert.ok(!JSON.stringify(reports).includes("secret-token"));
  assert.equal(await store.close(), true);
});

test("only one batch runs at a time and events arriving during its write are retained", async () => {
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const batches: InStatement[][] = [];
  const store = new AnalyticsStore(
    fake({
      batch: async (statements) => {
        calls++;
        batches.push(statements as InStatement[]);
        if (calls === 1) {
          started!();
          await wait;
        }
        return [];
      },
    }),
    { flushIntervalMs: 0, report: quiet },
  );
  store.enqueue(event());
  const first = store.flush();
  await began;
  store.enqueue(event({ event: "player_active" }));
  const second = store.flush();
  assert.equal(first, second);
  assert.equal(calls, 1);
  release!();
  await first;
  assert.equal(store.pendingCount, 1);
  await store.flush();
  assert.equal(calls, 2);
  assert.equal(store.pendingCount, 0);
  const next = batches[1][0] as { args: unknown[] };
  assert.equal(
    next.args[6],
    1,
    "the play received during the first write survives",
  );
  await store.close();
});

test("overflow stays bounded while existing devices merge, and final drain uses small batches", async () => {
  const reports: Record<string, unknown>[] = [];
  const sizes: number[] = [];
  let closed = 0;
  const store = new AnalyticsStore(
    fake({
      batch: async (statements) => {
        sizes.push(statements.length);
        return [];
      },
      close: () => {
        closed++;
      },
    }),
    {
      flushIntervalMs: 0,
      maxPending: 3,
      batchSize: 2,
      report: (record) => reports.push(record),
    },
  );
  for (const id of ["a", "b", "c", "d", "e"])
    store.enqueue(event({ device_id: id.repeat(64) }));
  store.enqueue(event({ event: "player_active" }));
  assert.equal(store.pendingCount, 3);
  assert.equal(
    reports.filter((record) => record.event === "overflow").length,
    1,
  );
  assert.equal(await store.close(), true);
  assert.deepEqual(sizes, [2, 1]);
  assert.equal(await store.close(), true);
  assert.equal(closed, 1);
  assert.equal(reports.at(-1)!.dropped_events, 2);
  store.enqueue(event());
  assert.equal(store.pendingCount, 0);
});

test("failed shutdown reports remaining rows and does not retry indefinitely", async () => {
  let calls = 0,
    closed = 0;
  const reports: Record<string, unknown>[] = [];
  const store = new AnalyticsStore(
    fake({
      batch: async () => {
        calls++;
        throw Error("offline");
      },
      close: () => {
        closed++;
      },
    }),
    { flushIntervalMs: 0, report: (record) => reports.push(record) },
  );
  store.enqueue(event());
  assert.equal(await store.close(), false);
  assert.equal(calls, 1);
  assert.equal(closed, 1);
  assert.equal(reports.at(-1)!.pending_rows, 1);
  assert.equal(reports.at(-1)!.drained, false);
});
