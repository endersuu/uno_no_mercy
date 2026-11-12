import { test } from "node:test";
import assert from "node:assert/strict";
import { Rooms } from "../src/server/rooms.js";
import type { View } from "../src/shared/types.js";
function setup() {
  let now = 0;
  const views = new Map<string, View>();
  const rooms = new Rooms(
    (id, v) => views.set(id, v),
    60_000,
    () => now,
  );
  const host = rooms.create("a", "Alice");
  const guest = rooms.join(host.room, "b", "Bob");
  return {
    rooms,
    host,
    guest,
    views,
    time: (n: number) => {
      now = n;
    },
  };
}
test("room starts with two humans, third player rejected; private hands", () => {
  const { rooms, host, views } = setup();
  assert.throws(() => rooms.join(host.room, "c", "Carol"));
  const a = views.get("a")!,
    b = views.get("b")!;
  assert.equal(a.phase, "playing");
  assert.equal(a.hand.length, 7);
  assert.ok(a.hand.every((c) => !JSON.stringify(b).includes(c.id)));
  assert.ok(!JSON.stringify(a).includes("token"));
});
test("manual pause blocks play and only initiator can resume", () => {
  const { rooms, views } = setup();
  rooms.update("a", views.get("a")!.revision, { type: "pause" });
  assert.throws(() =>
    rooms.update("b", views.get("b")!.revision, { type: "resume" }),
  );
  assert.throws(() =>
    rooms.update("a", views.get("a")!.revision, { type: "draw" }),
  );
  rooms.update("a", views.get("a")!.revision, { type: "resume" });
  assert.equal(views.get("a")!.pausedBy, null);
});
test("disconnect pauses; same credential reconnects within 60 seconds", () => {
  const { rooms, host, views, time } = setup();
  const ids = views.get("a")!.hand.map((c) => c.id);
  rooms.disconnect("a");
  assert.equal(views.get("b")!.disconnected, true);
  assert.equal(views.get("b")!.players[0].deadline, 60_000);
  time(59_999);
  rooms.join(host.room, "a2", "Alice", host.token);
  assert.equal(views.get("b")!.disconnected, false);
  assert.deepEqual(
    views.get("a2")!.hand.map((c) => c.id),
    ids,
  );
  assert.throws(() => rooms.join(host.room, "a3", "Alice", host.token));
});
test("reconnect does not clear manual pause", () => {
  const { rooms, host, views } = setup();
  rooms.update("a", views.get("a")!.revision, { type: "pause" });
  rooms.disconnect("a");
  rooms.join(host.room, "a2", "Alice", host.token);
  assert.equal(views.get("b")!.pausedBy, 0);
});
test("60-second deadline ends game, late reconnect rejected", () => {
  const { rooms, host, views, time } = setup();
  rooms.disconnect("a");
  time(60_000);
  assert.throws(() => rooms.join(host.room, "a2", "Alice", host.token));
  assert.equal(views.get("b")!.phase, "finished");
  assert.equal(views.get("b")!.winner, 1);
  assert.equal(views.get("b")!.closed, true);
});
test("explicit leave ends immediately; last seat leaving deletes room", () => {
  const { rooms, host, views } = setup();
  rooms.leave("a");
  assert.equal(views.get("b")!.phase, "finished");
  assert.throws(() =>
    rooms.update("b", views.get("b")!.revision, { type: "rematch" }),
  );
  rooms.leave("b");
  assert.equal(rooms.rooms.has(host.room), false);
});
test("both disconnected seats are retained for grace then deleted", () => {
  const { rooms, host, time } = setup();
  rooms.disconnect("a");
  rooms.disconnect("b");
  time(59_999);
  rooms.expire();
  assert.equal(rooms.rooms.has(host.room), true);
  time(60_000);
  rooms.expire();
  assert.equal(rooms.rooms.size, 0);
});
test("empty waiting room deleted immediately or after disconnect grace", () => {
  let now = 0;
  const r = new Rooms(
    () => {},
    60_000,
    () => now,
  );
  const a = r.create("a", "Alice");
  r.leave("a");
  assert.equal(r.rooms.has(a.room), false);
  r.create("b", "Bob");
  r.disconnect("b");
  now = 60_000;
  r.expire();
  assert.equal(r.rooms.size, 0);
});
test("waiting player reconnect starts game when guest already seated", () => {
  const r = new Rooms(() => {});
  const a = r.create("a", "Alice");
  r.disconnect("a");
  r.join(a.room, "b", "Bob");
  r.join(a.room, "a2", "Alice", a.token);
  assert.ok(r.rooms.get(a.room)!.game);
});
test("both must vote to rematch; new deck; stale actions rejected", () => {
  const { rooms, host, views } = setup();
  const r = rooms.rooms.get(host.room)!;
  r.game!.winner = 0;
  const old = r.game;
  rooms.update("a", views.get("a")!.revision, { type: "rematch" });
  assert.equal(r.game, old);
  assert.throws(() => rooms.update("b", 0, { type: "rematch" }));
  rooms.update("b", views.get("b")!.revision, { type: "rematch" });
  assert.notEqual(r.game, old);
  assert.equal(r.game!.winner, null);
  assert.equal(r.game!.turn, 1);
  assert.deepEqual(
    r.seats.map((s) => s?.rematch),
    [false, false],
  );
});
