import { test } from "node:test";
import assert from "node:assert/strict";
import { AnalyticsReport } from "../scripts/analytics-report.js";

function record(overrides: Record<string, unknown> = {}) {
  return {
    kind: "uno-analytics",
    schemaVersion: 1,
    at: "2026-11-23T12:00:00.000Z",
    event: "visitor_connected",
    run_id: "run-1",
    connection_id: "connection-1",
    device_id: "a".repeat(64),
    identity_scope: "persistent",
    browser: "Chrome",
    os: "Android",
    device_type: "mobile",
    language: "zh-CN",
    timezone: "Asia/Shanghai",
    source: "friends",
    referrer: "example.com",
    ...overrides,
  };
}

test("reports distinct visitors and actual players across reconnects, files and UTC days", () => {
  const report = new AnalyticsReport();
  const send = (overrides: Record<string, unknown> = {}) =>
    report.consume(JSON.stringify(record(overrides)));
  send();
  send(); // Overlapping exported files must not inflate uniques/connections.
  send({ event: "room_entered", room_id: "r1" });
  send({ event: "player_active", room_id: "r1", round_id: "round-1" });
  send({
    event: "player_active",
    connection_id: "reconnected",
    room_id: "r1",
    round_id: "round-1",
  });
  send({ device_id: "b".repeat(64), connection_id: "b", source: null });
  send({
    at: "2026-11-24T00:00:00.000Z",
    event: "player_active",
    room_id: "r1",
    round_id: "round-1",
    connection_id: "reconnected",
    source: "returning",
  });
  const result = report.result();
  assert.deepEqual(result.totals, {
    visitors: 2,
    players: 1,
    room_entrants: 1,
    connections: 3,
    rounds: 1,
  });
  assert.deepEqual(result.daily, [
    { date: "2026-11-23", visitors: 2, players: 1 },
    { date: "2026-11-24", visitors: 1, players: 1 },
  ]);
  assert.deepEqual(
    result.by_source.find((r) => r.source === "referrer:example.com"),
    { source: "referrer:example.com", visitors: 1, players: 0 },
  );
  assert.equal(result.by_source.length, 3);
  assert.equal(result.input.accepted_records, 7);
});

test("accepts prefixed logs and safely skips unrelated, malformed and incompatible records", () => {
  const report = new AnalyticsReport();
  report.consume("UNO server listening on port 3000");
  report.consume('{"kind":"some-other-service"}');
  report.consume('{"kind":"uno-analytics", broken');
  for (const change of [
    { schemaVersion: 99 },
    { device_id: "arbitrary-untrusted-text" },
    { at: "2026-02-31T12:00:00.000Z" },
    { source: { polluted: true } },
    { event: "player_active" },
  ])
    report.consume(JSON.stringify(record(change)));
  report.consume(
    "2026-11-23T12:00:00Z [service] " +
      JSON.stringify(record({ source: null, referrer: null })),
  );
  const result = report.result();
  assert.deepEqual(result.input, {
    accepted_records: 1,
    malformed_records: 6,
    ignored_lines: 2,
  });
  assert.deepEqual(result.by_source, [
    { source: "direct/unknown", visitors: 1, players: 0 },
  ]);
});

test("connection and round keys include server runs, and partial exports still count observed players", () => {
  const report = new AnalyticsReport();
  for (const run_id of ["run-1", "run-2"])
    report.consume(
      JSON.stringify(
        record({
          event: "player_active",
          run_id,
          room_id: "same-room",
          round_id: "same-round",
          identity_scope: "ephemeral",
        }),
      ),
    );
  const result = report.result();
  assert.equal(result.totals.visitors, 1);
  assert.equal(result.totals.players, 1);
  assert.equal(result.totals.connections, 2);
  assert.equal(result.totals.rounds, 2);
  assert.deepEqual(result.by_identity_scope, [
    { identity_scope: "ephemeral", visitors: 1, players: 1 },
  ]);
  assert.equal(JSON.stringify(result).includes("a".repeat(64)), false);
});

test("empty input produces an explicit empty report", () => {
  const result = new AnalyticsReport().result();
  assert.deepEqual(result.range, { first: null, last: null });
  assert.equal(result.totals.visitors, 0);
  assert.deepEqual(result.daily, []);
});

test("groups language and timezone hints without inventing physical locations", () => {
  const report = new AnalyticsReport();
  report.consume(JSON.stringify(record()));
  report.consume(
    JSON.stringify(
      record({
        device_id: "b".repeat(64),
        connection_id: "b",
        language: null,
        timezone: null,
      }),
    ),
  );
  const result = report.result();
  assert.deepEqual(
    result.by_language.find((r) => r.language === "zh-CN"),
    {
      language: "zh-CN",
      visitors: 1,
      players: 0,
    },
  );
  assert.deepEqual(
    result.by_timezone.find((r) => r.timezone === "unknown"),
    {
      timezone: "unknown",
      visitors: 1,
      players: 0,
    },
  );
  assert.equal("country" in result, false);
});
