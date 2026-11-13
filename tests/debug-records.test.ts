import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DebugRecords } from "../src/server/debug-records.js";
import { Rooms } from "../src/server/rooms.js";
import type { Card, RoomAction, View } from "../src/shared/types.js";

function setup(
  t: TestContext,
  options: { failStart?: boolean; failAppend?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "uno-debug-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storage = new DebugRecords(
    options.failStart ? join(root, "missing", "directory") : root,
    options.failAppend
      ? () => {
          throw Error("simulated disk full");
        }
      : undefined,
  );
  const views = new Map<string, View>();
  let now = 1_000;
  const rooms = new Rooms(
    (socket, view) => views.set(socket, view),
    60_000,
    () => now,
    storage,
  );
  const host = rooms.create("socket-alice", "Alice");
  const guest = rooms.join(host.room, "socket-bob", "Bob");
  const move = (socket: string, action: RoomAction) =>
    rooms.update(socket, views.get(socket)!.revision, action);
  return {
    root,
    rooms,
    views,
    host,
    guest,
    move,
    storage,
    time: (value: number) => {
      now = value;
    },
  };
}
function recordFile(root: string) {
  const directory = join(root, readdirSync(root)[0]);
  return join(directory, readdirSync(directory)[0]);
}

test("debug export captures original shuffled deck, actual alternating deal and private state without credentials", (t) => {
  const { rooms, host, guest, views } = setup(t);
  const snapshot = rooms.debugSnapshot("socket-alice");
  assert.equal(snapshot.kind, "uno-debug-snapshot");
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.round.entryCount, 1);
  assert.equal(snapshot.round.round, 1);
  assert.deepEqual(snapshot.players, ["Alice", "Bob"]);
  assert.equal(snapshot.initialDeck.length, 168);
  assert.equal(new Set(snapshot.initialDeck.map((c) => c.id)).size, 168);
  const pile = [...snapshot.initialDeck];
  const hands: Card[][] = [[], []];
  for (let i = 0; i < 7; i++) for (const hand of hands) hand.push(pile.pop()!);
  const discard: Card[] = [];
  do {
    discard.push(pile.pop()!);
  } while (discard.at(-1)!.kind !== "number");
  const initial = snapshot.entries[0];
  assert.equal(initial.kind, "start");
  assert.equal(initial.before, null);
  assert.deepEqual(initial.after.game.hands, hands);
  assert.deepEqual(initial.after.game.discard, discard);
  assert.deepEqual(initial.after.game.deck, pile);
  assert.deepEqual(initial.after, snapshot.current);
  assert.equal(initial.after.revision, views.get("socket-alice")!.revision);
  const json = JSON.stringify(snapshot);
  for (const secret of [host.token, guest.token, "socket-alice", "socket-bob"])
    assert.equal(json.includes(secret), false);
  assert.equal(/"(?:token|socket)"\s*:/.test(json), false);
  const aView = JSON.stringify(views.get("socket-alice"));
  for (const card of snapshot.current.game.hands[1])
    assert.equal(aView.includes(card.id), false);
  assert.equal(aView.includes("initialDeck"), false);
  snapshot.current.game.hands[0].length = 0;
  snapshot.entries[0].after.game.hands[0].length = 0;
  assert.equal(
    rooms.debugSnapshot("socket-alice").current.game.hands[0].length,
    7,
  );
});

test("all actions beyond the twelve-line UI log are retained with immutable before/after states", (t) => {
  const { rooms, move } = setup(t);
  for (let i = 0; i < 16; i++) {
    move("socket-alice", { type: "pause" });
    move("socket-alice", { type: "resume" });
  }
  const snapshot = rooms.debugSnapshot("socket-bob");
  assert.equal(snapshot.entries.length, 33);
  assert.equal(snapshot.round.entryCount, 33);
  assert.equal(snapshot.entries[0].after.pausedBy, null);
  assert.equal(snapshot.entries[1].after.pausedBy, 0);
  for (let i = 1; i < snapshot.entries.length; i++) {
    const entry = snapshot.entries[i];
    assert.equal(entry.sequence, i + 1);
    assert.equal(entry.accepted, true);
    assert.deepEqual(entry.before, snapshot.entries[i - 1].after);
    assert.equal(entry.after.revision, entry.before!.revision + 1);
  }
  assert.deepEqual(snapshot.current, snapshot.entries.at(-1)!.after);
});

test("illegal and stale actions include the rejection and unchanged state, while arbitrary payloads are omitted", (t) => {
  const { rooms, move, views } = setup(t);
  const before = rooms.debugSnapshot("socket-alice").current;
  const revision = views.get("socket-alice")!.revision;
  assert.throws(
    () => rooms.update("socket-alice", revision - 1, { type: "pause" }),
    /状态已更新/,
  );
  assert.throws(() => move("socket-bob", { type: "draw" }), /轮到/);
  assert.throws(() =>
    move("socket-alice", {
      type: "play",
      cardId: "not-held",
      color: { hidden: "do-not-record" },
      token: "do-not-record",
    } as unknown as RoomAction),
  );
  const snapshot = rooms.debugSnapshot("socket-alice");
  assert.equal(snapshot.entries.length, 4);
  assert.equal(snapshot.entries[1].requestedRevision, revision - 1);
  for (const entry of snapshot.entries.slice(1)) {
    assert.equal(entry.accepted, false);
    assert.ok(entry.error);
    assert.deepEqual(entry.before, before);
    assert.deepEqual(entry.after, before);
  }
  assert.deepEqual(snapshot.entries.at(-1)!.action, {
    type: "play",
    cardId: "not-held",
  });
  assert.equal(JSON.stringify(snapshot).includes("do-not-record"), false);
});

test("played cards, selected color, UNO choice and challenge draw result are preserved", (t) => {
  const { rooms, host, move } = setup(t);
  const game = rooms.rooms.get(host.room)!.game!;
  for (const [handIndex, predicate] of [
    [0, (c: Card) => c.kind === "wild4"],
    [1, (c: Card) => c.color === "red" && c.kind === "number"],
  ] as const) {
    const zone = [game.deck, ...game.hands, game.discard].find((cards) =>
      cards.some(predicate),
    )!;
    const i = zone.findIndex(predicate);
    [game.hands[0][handIndex], zone[i]] = [zone[i], game.hands[0][handIndex]];
  }
  game.color = "red";
  const played = structuredClone(game.hands[0][0]);
  const before = structuredClone(game.hands);
  move("socket-alice", {
    type: "play",
    cardId: played.id,
    color: "blue",
    uno: true,
  });
  move("socket-bob", { type: "challenge" });
  const snapshot = rooms.debugSnapshot("socket-alice");
  const play = snapshot.entries[1],
    challenge = snapshot.entries[2];
  assert.deepEqual(play.action, {
    type: "play",
    cardId: played.id,
    color: "blue",
    uno: true,
  });
  assert.deepEqual(play.before!.game.hands, before);
  assert.deepEqual(play.after.game.event!.card, played);
  assert.equal(play.after.game.color, "blue");
  assert.deepEqual(challenge.before, play.after);
  assert.equal(challenge.after.game.event!.challengeWon, true);
  assert.deepEqual(challenge.after.game.event!.drawn, [4, 0]);
  assert.equal(challenge.after.game.hands[0].length, before[0].length - 1 + 4);
  assert.equal(challenge.after.game.penalty, 0);
});

test("reconnect continues the same log and rematch retains old round without mixing the next deal", (t) => {
  const { rooms, host, views, move } = setup(t);
  const first = rooms.debugSnapshot("socket-alice").round.roundId;
  rooms.disconnect("socket-alice");
  rooms.join(host.room, "rejoined-alice", "Alice", host.token);
  assert.throws(() => rooms.debugSnapshot("socket-alice"), /先加入/);
  rooms.rooms.get(host.room)!.game!.winner = 0;
  rooms.update("rejoined-alice", views.get("rejoined-alice")!.revision, {
    type: "rematch",
  });
  move("socket-bob", { type: "rematch" });
  const current = rooms.debugSnapshot("rejoined-alice");
  const old = rooms.debugSnapshot("socket-bob", first);
  assert.equal(current.round.round, 2);
  assert.notEqual(current.round.roundId, first);
  assert.equal(current.entries.length, 1);
  assert.equal(old.entries.length, 5);
  assert.deepEqual(
    old.entries.slice(1).map((entry) => entry.kind),
    ["disconnect", "reconnect", "action", "action"],
  );
  assert.deepEqual(
    old.entries.slice(-2).map((entry) => entry.action),
    [{ type: "rematch" }, { type: "rematch" }],
  );
  assert.ok(old.entries.every((entry) => entry.after.game.roundId === first));
  assert.equal(old.current.game.winner, 0);
  assert.equal(old.round.finishedAt !== null, true);
  assert.equal(current.current.game.turn, 1);
  assert.deepEqual(
    views.get("socket-bob")!.debugRounds!.map((round) => round.round),
    [1, 2],
  );
});

test("only seated participants can export their room and last departure removes all recording files", (t) => {
  const { rooms, root, host } = setup(t);
  const round = rooms.debugSnapshot("socket-alice").round.roundId;
  assert.throws(() => rooms.debugSnapshot("stranger"), /先加入/);
  const other = rooms.create("other-host", "Other");
  rooms.join(other.room, "other-guest", "Guest");
  assert.throws(() => rooms.debugSnapshot("other-host", round), /当前房间/);
  assert.throws(
    () => rooms.debugSnapshot("socket-alice", "../../etc/passwd"),
    /当前房间/,
  );
  rooms.leave("socket-bob");
  const end = rooms.debugSnapshot("socket-alice");
  assert.equal(end.entries.at(-1)!.kind, "leave");
  assert.equal(end.current.closed, true);
  assert.equal(end.current.game.winner, 0);
  rooms.leave("socket-alice");
  assert.equal(rooms.rooms.has(host.room), false);
  rooms.leave("other-host");
  rooms.leave("other-guest");
  assert.deepEqual(readdirSync(root), []);
});

test("disconnect timeout is an explicit end-of-round event", (t) => {
  const { rooms, time } = setup(t);
  rooms.disconnect("socket-bob");
  time(61_000);
  rooms.expire();
  const snapshot = rooms.debugSnapshot("socket-alice");
  assert.equal(snapshot.entries.at(-1)!.kind, "expire");
  assert.equal(snapshot.entries.at(-1)!.actor, 1);
  assert.equal(snapshot.current.game.winner, 0);
  assert.equal(snapshot.round.finishedAt, new Date(61_000).toISOString());
});

test("recording failures never block play and archived incomplete exports retain their latest state", (t) => {
  for (const options of [{ failStart: true }, { failAppend: true }]) {
    const { rooms, host, move } = setup(t, options);
    move("socket-alice", { type: "pause" });
    move("socket-alice", { type: "resume" });
    const first = rooms.debugSnapshot("socket-alice").round.roundId;
    rooms.rooms.get(host.room)!.game!.winner = 0;
    move("socket-alice", { type: "rematch" });
    move("socket-bob", { type: "rematch" });
    const snapshot = rooms.debugSnapshot("socket-alice", first);
    assert.equal(snapshot.complete, false);
    assert.ok(snapshot.recordingError);
    assert.equal(snapshot.round.entryCount, 5);
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.current.game.winner, 0);
    assert.equal(
      snapshot.current.players.every((player) => player.rematch),
      true,
    );
  }
});

test("whole-line truncation or a changed sequence is reported as incomplete", (t) => {
  for (const change of ["truncate", "sequence"] as const) {
    const { root, rooms, move } = setup(t);
    move("socket-alice", { type: "pause" });
    move("socket-alice", { type: "resume" });
    const file = recordFile(root);
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    if (change === "truncate") lines.pop();
    else {
      const last = JSON.parse(lines.at(-1)!);
      last.sequence = 99;
      lines[lines.length - 1] = JSON.stringify(last);
    }
    writeFileSync(file, lines.join("\n") + "\n");
    const snapshot = rooms.debugSnapshot("socket-alice");
    assert.equal(snapshot.complete, false);
    assert.ok(snapshot.recordingError);
    assert.equal(snapshot.entries.length, 2);
    assert.equal(snapshot.current.pausedBy, null);
  }
});

test("invalid selected colors are recorded as rejected without retaining the unsafe payload", (t) => {
  const { rooms, move } = setup(t);
  const initial = rooms.debugSnapshot("socket-alice").current;
  const cardId = initial.game.hands[0][0].id;
  for (const color of ["purple", null, 7, { hidden: "unsafe-color-payload" }])
    assert.throws(
      () =>
        move("socket-alice", {
          type: "play",
          cardId,
          color,
        } as unknown as RoomAction),
      /有效颜色/,
    );
  const snapshot = rooms.debugSnapshot("socket-alice");
  assert.equal(snapshot.entries.length, 5);
  for (const entry of snapshot.entries.slice(1)) {
    assert.equal(entry.accepted, false);
    assert.match(entry.error!, /有效颜色/);
    assert.deepEqual(entry.action, { type: "play", cardId });
    assert.deepEqual(entry.before, initial);
    assert.deepEqual(entry.after, initial);
  }
  assert.equal(
    JSON.stringify(snapshot).includes("unsafe-color-payload"),
    false,
  );
});

test("invalid card identifiers and UNO choices are rejected and recorded without raw payloads", (t) => {
  const { rooms, move } = setup(t);
  const initial = rooms.debugSnapshot("socket-alice").current;
  const cardId = initial.game.hands[0][0].id;
  const attempts = [
    { type: "play", cardId: { hidden: "raw-field-secret" } },
    { type: "play", cardId: "x".repeat(65) },
    { type: "play", cardId, uno: { hidden: "raw-field-secret" } },
    { type: "play", cardId, uno: "false" },
  ];
  for (const action of attempts)
    assert.throws(
      () => move("socket-alice", action as unknown as RoomAction),
      /无效牌/,
    );
  const snapshot = rooms.debugSnapshot("socket-alice");
  assert.equal(snapshot.entries.length, 5);
  for (const entry of snapshot.entries.slice(1)) {
    assert.equal(entry.accepted, false);
    assert.match(entry.error!, /无效牌/);
    assert.deepEqual(entry.before, initial);
    assert.deepEqual(entry.after, initial);
    assert.equal(entry.action?.uno, undefined);
  }
  assert.deepEqual(snapshot.entries[1].action, { type: "play" });
  assert.deepEqual(snapshot.entries[2].action, { type: "play" });
  assert.deepEqual(snapshot.entries[3].action, { type: "play", cardId });
  assert.equal(JSON.stringify(snapshot).includes("raw-field-secret"), false);
});

test("missing files and damaged headers still export the initial and latest archived states", (t) => {
  for (const damage of ["missing", "header"] as const) {
    const { root, rooms, host, move } = setup(t);
    const initial = rooms.debugSnapshot("socket-alice");
    const file = recordFile(root);
    move("socket-alice", { type: "pause" });
    move("socket-alice", { type: "resume" });
    rooms.rooms.get(host.room)!.game!.winner = 0;
    move("socket-alice", { type: "rematch" });
    move("socket-bob", { type: "rematch" });
    const finished = rooms.debugSnapshot("socket-alice", initial.round.roundId);
    assert.equal(finished.entries.length, 5);
    if (damage === "missing") rmSync(file);
    else {
      const lines = readFileSync(file, "utf8").split("\n");
      lines[0] = "{broken header";
      writeFileSync(file, lines.join("\n"));
    }
    const recovered = rooms.debugSnapshot(
      "socket-alice",
      initial.round.roundId,
    );
    assert.equal(recovered.complete, false);
    assert.ok(recovered.recordingError);
    assert.equal(recovered.entries.length, 1);
    assert.equal(recovered.round.entryCount, 5);
    assert.deepEqual(recovered.initialDeck, initial.initialDeck);
    assert.deepEqual(recovered.entries[0], initial.entries[0]);
    assert.deepEqual(recovered.current, finished.current);
    assert.equal(recovered.current.game.winner, 0);
    assert.equal(
      recovered.current.players.every((player) => player.rematch),
      true,
    );
  }
});
