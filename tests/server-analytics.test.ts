import { test } from "node:test";
import assert from "node:assert/strict";
import { Analytics, deviceInfo } from "../src/server/analytics.js";
import { Rooms } from "../src/server/rooms.js";
import type { View } from "../src/shared/types.js";

const deviceId = "12345678-abcd-4abc-8abc-123456789abc";
const metadata = { deviceId, storage: "persistent" };
interface Log {
  event: string;
  at: string;
  run_id: string;
  connection_id: string;
  device_id: string;
  identity_scope: string;
  duration_ms?: number;
  [key: string]: unknown;
}
function capture() {
  const lines: string[] = [];
  let now = Date.parse("2026-11-23T23:59:59.000Z");
  const analytics = new Analytics(
    true,
    (line) => lines.push(line),
    () => now,
  );
  return {
    analytics,
    lines,
    logs: () => lines.map((line) => JSON.parse(line) as Log),
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}
function state(overrides: Partial<View> = {}): View {
  return {
    roundId: "round-1",
    event: null,
    room: "room-1",
    revision: 1,
    me: 0,
    players: [],
    phase: "playing",
    hand: [],
    top: null,
    color: "red",
    turn: 0,
    playable: [],
    penalty: 0,
    lastPenalty: 0,
    challenge: false,
    roulette: false,
    winner: null,
    reason: "",
    pausedBy: null,
    disconnected: false,
    log: [],
    canCatch: false,
    unoNeeded: false,
    closed: false,
    ...overrides,
  };
}

test("browser identities survive reconnects, process restarts, and changed network IPs without logging credentials", () => {
  const a = capture(),
    b = capture();
  const privateMetadata = {
    ...metadata,
    token: "private-seat-token",
    name: "private-player-name",
    password: "private-password",
    userAgent: "private-raw-ua",
  };
  a.analytics.connect(
    "socket-a",
    privateMetadata,
    "Chrome/142.0 Safari/537.36",
    "192.0.2.1",
  );
  a.analytics.connect(
    "socket-b",
    metadata,
    "Chrome/142.0 Safari/537.36",
    "198.51.100.2",
  );
  b.analytics.connect(
    "socket-c",
    { ...metadata, deviceId: deviceId.toUpperCase() },
    "",
    null,
  );
  const [first, reconnect] = a.logs(),
    [restart] = b.logs();
  assert.match(first.device_id, /^[a-f0-9]{64}$/);
  assert.equal(first.device_id, reconnect.device_id);
  assert.equal(first.device_id, restart.device_id);
  assert.notEqual(first.run_id, restart.run_id);
  assert.equal(first.identity_scope, "persistent");
  for (const secret of [
    deviceId,
    "private-seat-token",
    "private-player-name",
    "private-password",
    "private-raw-ua",
  ])
    assert.ok(!a.lines.join("\n").includes(secret));
});

test("legacy or malformed clients remain playable and do not collapse into one unknown device", () => {
  const c = capture();
  for (const [i, value] of [
    undefined,
    null,
    [],
    "bad",
    { deviceId: "spoof\nentry" },
    { deviceId: 42 },
  ].entries()) {
    assert.doesNotThrow(() =>
      c.analytics.connect(`socket-${i}`, value, undefined, null),
    );
  }
  const logs = c.logs();
  assert.equal(new Set(logs.map((log) => log.device_id)).size, logs.length);
  assert.ok(logs.every((log) => log.identity_scope === "connection"));
  c.analytics.connect(
    "ephemeral",
    { deviceId, storage: "ephemeral" },
    "",
    null,
  );
  assert.equal(c.logs().at(-1)!.identity_scope, "ephemeral");
});

test("untrusted attribution cannot inject log lines or smuggle full URLs and client secrets", () => {
  const c = capture();
  c.analytics.connect(
    "malicious",
    {
      ...metadata,
      referrer: "example.com/private?token=secret",
      source: 'campaign\n{"event":"player_active"}',
      medium: "x".repeat(81),
      campaign: { secret: true },
      language: "zh-CN\nsecret",
      timezone: "Unknown/Secret",
    },
    { secret: true },
    "not-an-ip",
  );
  assert.equal(c.lines.length, 1);
  assert.ok(!c.lines[0].includes("\n"));
  const bad = c.logs()[0];
  for (const field of [
    "referrer",
    "source",
    "medium",
    "campaign",
    "language",
    "timezone",
    "network_ip",
  ])
    assert.equal(bad[field], null, field);
  c.analytics.connect(
    "valid",
    {
      ...metadata,
      referrer: "Example.COM",
      source: " social ",
      medium: "link",
      campaign: "launch-2026",
      language: "zh-Hans-CN",
      timezone: "Asia/Shanghai",
    },
    "",
    "2001:db8::1",
  );
  const good = c.logs()[1];
  assert.equal(good.referrer, "example.com");
  assert.equal(good.source, "social");
  assert.equal(good.language, "zh-Hans-CN");
  assert.equal(good.timezone, "Asia/Shanghai");
  assert.equal(good.network_ip, "2001:db8::1");
});

test("overlapping UA tokens classify Edge and mobile browsers before generic Chrome and Safari", () => {
  assert.deepEqual(
    deviceInfo(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36 Edg/140.0",
    ),
    {
      browser: "Edge",
      os: "Windows",
      device_type: "desktop",
    },
  );
  assert.deepEqual(
    deviceInfo(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) CriOS/140.0 Mobile/15E148 Safari/604.1",
    ),
    {
      browser: "Chrome",
      os: "iOS",
      device_type: "mobile",
    },
  );
  assert.deepEqual(
    deviceInfo(
      "Mozilla/5.0 (Linux; Android 15; Tablet) Chrome/140.0 Safari/537.36",
    ),
    {
      browser: "Chrome",
      os: "Android",
      device_type: "tablet",
    },
  );
  assert.deepEqual(deviceInfo(null), {
    browser: "unknown",
    os: "unknown",
    device_type: "unknown",
  });
});

test("only active play is counted, with one event per round and UTC day despite repeated state broadcasts", () => {
  const c = capture();
  c.analytics.connect("s", metadata, "", null);
  for (const overrides of [
    { phase: "waiting" as const },
    { phase: "finished" as const },
    { disconnected: true },
    { closed: true },
    { pausedBy: 0 },
    { roundId: null },
  ])
    c.analytics.observeState("s", state(overrides));
  assert.equal(
    c.logs().filter((log) => log.event === "player_active").length,
    0,
  );
  for (let i = 0; i < 50; i++)
    c.analytics.observeState("s", state({ revision: i }));
  assert.equal(
    c.logs().filter((log) => log.event === "player_active").length,
    1,
  );
  c.advance(1000);
  c.analytics.observeState("s", state());
  c.analytics.observeState("s", state({ roundId: "round-2" }));
  c.analytics.observeState("s", state({ roundId: "round-2" }));
  const active = c.logs().filter((log) => log.event === "player_active");
  assert.equal(active.length, 3);
  assert.equal(active[0].at.slice(0, 10), "2026-11-23");
  assert.equal(active[1].at.slice(0, 10), "2026-11-24");
  assert.equal(active[2].round_id, "round-2");
});

test("real room broadcasts count both players at game start and keep reconnects deduplicable", () => {
  const c = capture();
  const rooms = new Rooms((id, view) => c.analytics.observeState(id, view));
  c.analytics.connect("a", metadata, "", null);
  c.analytics.connect(
    "b",
    { ...metadata, deviceId: "87654321-abcd-4abc-8abc-123456789abc" },
    "",
    null,
  );
  const created = rooms.create("a", "private-alice");
  assert.equal(
    c.logs().filter((log) => log.event === "player_active").length,
    0,
  );
  rooms.join(created.room, "b", "private-bob");
  const initial = c.logs().filter((log) => log.event === "player_active");
  assert.equal(initial.length, 2);
  assert.equal(new Set(initial.map((log) => log.device_id)).size, 2);
  c.analytics.disconnect("a", "transport close");
  rooms.disconnect("a");
  c.analytics.connect("a2", metadata, "", "198.51.100.2");
  rooms.join(created.room, "a2", "private-alice", created.token);
  const active = c.logs().filter((log) => log.event === "player_active");
  assert.equal(active.length, 3);
  assert.equal(new Set(active.map((log) => log.device_id)).size, 2);
  for (const secret of [created.token, "private-alice", "private-bob"])
    assert.ok(!c.lines.join("\n").includes(secret));
});

test("disconnect releases tracking, logs duration once, and ignores stale lifecycle events", () => {
  const c = capture();
  c.analytics.connect("s", metadata, "", null);
  c.analytics.connect("s", { deviceId: "invalid" }, "", null);
  c.advance(1234);
  c.analytics.disconnect("s", "transport close");
  c.analytics.disconnect("s", "transport close");
  c.analytics.observeState("s", state());
  c.analytics.roomEntered("s", "room");
  assert.equal(c.logs().length, 2);
  assert.equal(c.logs()[1].duration_ms, 1234);
  c.analytics.connect("s", metadata, "", null);
  c.analytics.observeState("s", state());
  assert.equal(c.logs().length, 4);
});

test("disabled analytics and failed log writers cannot interrupt game lifecycle calls", () => {
  let writes = 0;
  const disabled = new Analytics(false, () => {
    writes++;
  });
  const broken = new Analytics(true, () => {
    throw Error("log sink unavailable");
  });
  for (const analytics of [disabled, broken]) {
    assert.doesNotThrow(() => {
      analytics.connect("s", metadata, "", null);
      analytics.roomEntered("s", "room-1");
      analytics.observeState("s", state());
      analytics.disconnect("s", "transport close");
    });
  }
  assert.equal(writes, 0);
});

test("database persistence continues across the game lifecycle when stdout fails", () => {
  const records: Record<string, unknown>[] = [];
  const analytics = new Analytics(
    true,
    () => {
      throw Error("stdout unavailable");
    },
    () => Date.parse("2026-11-23T00:00:00Z"),
    (record) => records.push(record),
  );
  assert.doesNotThrow(() => {
    analytics.connect("s", metadata, "", null);
    analytics.roomEntered("s", "room-1");
    analytics.observeState("s", state());
    analytics.disconnect("s", "transport close");
  });
  assert.deepEqual(
    records.map((record) => record.event),
    [
      "visitor_connected",
      "room_entered",
      "player_active",
      "visitor_disconnected",
    ],
  );
  assert.equal(new Set(records.map((record) => record.device_id)).size, 1);
  assert.ok(!JSON.stringify(records).includes(deviceId));
});

test("stdout continues when persistence fails and disabled analytics bypasses both sinks", () => {
  const lines: string[] = [];
  let persistenceCalls = 0;
  const persist = () => {
    persistenceCalls++;
    throw Error("database unavailable");
  };
  for (const enabled of [true, false]) {
    const analytics = new Analytics(
      enabled,
      (line) => lines.push(line),
      () => Date.parse("2026-11-23T00:00:00Z"),
      persist,
    );
    assert.doesNotThrow(() => {
      analytics.connect("s", metadata, "", null);
      analytics.roomEntered("s", "room-1");
      analytics.observeState("s", state());
      analytics.disconnect("s", "transport close");
    });
  }
  assert.equal(persistenceCalls, 4);
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).event),
    [
      "visitor_connected",
      "room_entered",
      "player_active",
      "visitor_disconnected",
    ],
  );
});
