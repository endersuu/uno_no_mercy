import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createClient, type Client } from "@libsql/client";
import { ensureAnalyticsSchema } from "../src/server/analytics-store.js";
import {
  parseDateRange,
  readAnalyticsDatabase,
} from "../scripts/analytics-db-report.js";

async function fixture(run: (client: Client) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "uno-db-report-"));
  const client = createClient({
    url: pathToFileURL(join(directory, "test.db")).href,
  });
  try {
    await run(client);
  } finally {
    client.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function row(
  client: Client,
  options: {
    day?: string;
    device?: string;
    source?: string | null;
    medium?: string | null;
    referrer?: string | null;
    played?: number;
    entered?: number;
    language?: string | null;
    timezone?: string | null;
  } = {},
) {
  const day = options.day ?? "2026-11-23";
  const source = options.source === undefined ? "wechat" : options.source;
  const medium = options.medium ?? null;
  const referrer = options.referrer ?? null;
  await client.execute({
    sql: `INSERT INTO analytics_daily
      (day, device_id, attribution_key, first_seen, last_seen, room_entered, played,
       identity_scope, browser, os, device_type, language, timezone, source, medium, campaign, referrer)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      day,
      (options.device ?? "a").repeat(64),
      JSON.stringify([source, medium, null, referrer]),
      `${day}T12:00:00.000Z`,
      `${day}T13:00:00.000Z`,
      options.entered ?? 0,
      options.played ?? 0,
      "persistent",
      "Chrome",
      "Android",
      "mobile",
      options.language === undefined ? "zh-CN" : options.language,
      options.timezone === undefined ? "Asia/Shanghai" : options.timezone,
      source,
      medium,
      null,
      referrer,
    ],
  });
}

test("database report deduplicates browsers across days and attribution rows", async () => {
  await fixture(async (client) => {
    await ensureAnalyticsSchema(client);
    await row(client, { entered: 1, played: 1 });
    await row(client, { medium: "link", entered: 1, played: 1 });
    await row(client, { source: "friends", entered: 1, played: 1 });
    await row(client, { day: "2026-11-24", entered: 1, played: 1 });
    await row(client, { device: "b", source: null, referrer: "example.com" });
    await row(client, {
      device: "c",
      source: null,
      entered: 1,
      language: null,
      timezone: null,
    });
    await client.execute("PRAGMA query_only = ON");
    const result = await readAnalyticsDatabase(client);
    assert.deepEqual(result.totals, {
      visitors: 3,
      players: 1,
      room_entrants: 2,
    });
    assert.deepEqual(result.daily, [
      { date: "2026-11-23", visitors: 3, players: 1, room_entrants: 2 },
      { date: "2026-11-24", visitors: 1, players: 1, room_entrants: 1 },
    ]);
    assert.deepEqual(
      result.by_source.find((r) => r.source === "utm:wechat"),
      { source: "utm:wechat", visitors: 1, players: 1, room_entrants: 1 },
    );
    assert.deepEqual(
      result.by_source.find((r) => r.source === "referrer:example.com"),
      {
        source: "referrer:example.com",
        visitors: 1,
        players: 0,
        room_entrants: 0,
      },
    );
    assert.deepEqual(
      result.by_language.find((r) => r.language === "unknown"),
      { language: "unknown", visitors: 1, players: 0, room_entrants: 1 },
    );
    assert.equal("connections" in result.totals, false);
    assert.equal("rounds" in result.totals, false);
    assert.equal(JSON.stringify(result).includes("a".repeat(64)), false);
  });
});

test("date bounds are UTC inclusive and support empty result ranges", async () => {
  await fixture(async (client) => {
    await ensureAnalyticsSchema(client);
    await row(client, { day: "2026-11-22", device: "a" });
    await row(client, { day: "2026-11-23", device: "b", played: 1 });
    await row(client, { day: "2026-11-24", device: "c" });
    const result = await readAnalyticsDatabase(client, {
      from: "2026-11-23",
      to: "2026-11-23",
    });
    assert.deepEqual(result.totals, {
      visitors: 1,
      players: 1,
      room_entrants: 0,
    });
    assert.equal(result.range.first, "2026-11-23T12:00:00.000Z");
    assert.equal(result.range.last, "2026-11-23T13:00:00.000Z");
    const empty = await readAnalyticsDatabase(client, { from: "2026-12-01" });
    assert.deepEqual(empty.totals, {
      visitors: 0,
      players: 0,
      room_entrants: 0,
    });
    assert.deepEqual(empty.daily, []);
    assert.equal(empty.range.first, null);
  });
});

test("read-only reporting does not initialize a missing table", async () => {
  await fixture(async (client) => {
    await assert.rejects(readAnalyticsDatabase(client));
    const tables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    assert.deepEqual(tables.rows, []);
  });
});

test("date arguments reject invalid, duplicate, inverted and injected values", () => {
  assert.deepEqual(
    parseDateRange(["--from", "2024-02-29", "--to", "2024-03-01"]),
    { from: "2024-02-29", to: "2024-03-01" },
  );
  assert.deepEqual(parseDateRange([]), {});
  for (const args of [
    ["--from", "2026-02-29"],
    ["--to"],
    ["--from", "2026-11-24", "--to", "2026-11-23"],
    ["--from", "2026-11-23", "--from", "2026-11-24"],
    ["--from", "2026-11-23' OR 1=1 --"],
    ["--unknown", "anything"],
  ])
    assert.throws(() => parseDateRange(args));
});

test("CLI configuration failures never print database URLs or tokens", () => {
  const url = "invalid-secret-url-for-test";
  const token = "private-test-token-do-not-print";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TURSO_DATABASE_URL: url,
    TURSO_AUTH_TOKEN: token,
  };
  // This child is a user CLI, not a subprocess of the node:test runner.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/analytics-db-report.ts"],
    {
      cwd: new URL("..", import.meta.url),
      env,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /无法读取统计数据库/);
  assert.equal((result.stdout + result.stderr).includes(url), false);
  assert.equal((result.stdout + result.stderr).includes(token), false);
});
