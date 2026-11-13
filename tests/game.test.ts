import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { act, deck, newGame, playable, type Game } from "../src/server/game.js";
import type { Card, Color, Kind } from "../src/shared/types.js";
const c = (
  kind: Kind = "number",
  color: Color | null = "red",
  value = 3,
): Card => ({
  id: randomUUID(),
  kind,
  color,
  ...(kind === "number" ? { value } : {}),
});
function fixture(): Game {
  const g = newGame();
  g.hands = [
    [c(), c("number", "blue", 9)],
    [c("number", "green", 2), c("number", "yellow", 8)],
  ];
  g.discard = [c("number", "red", 5)];
  g.color = "red";
  return g;
}
function play(g: Game, p: number, card: Card) {
  act(g, p, {
    type: "play",
    cardId: card.id,
    ...(!card.color && card.kind !== "roulette"
      ? { color: "blue" as Color }
      : {}),
  });
}
test("168 unique cards with exact colored and wild composition", () => {
  const d = deck();
  assert.equal(d.length, 168);
  for (const color of ["red", "yellow", "green", "blue"])
    for (let v = 0; v < 10; v++)
      assert.equal(
        d.filter(
          (c) => c.color === color && c.kind === "number" && c.value === v,
        ).length,
        2,
      );
  assert.equal(new Set(d.map((c) => c.id)).size, 168);
  for (const color of ["red", "yellow", "green", "blue"])
    assert.equal(d.filter((c) => c.color === color).length, 36);
  for (const [kind, n] of [
    ["wild4", 8],
    ["wild6", 4],
    ["wild10", 4],
    ["roulette", 8],
  ] as const)
    assert.equal(d.filter((c) => c.kind === kind).length, n);
});
test("deal seven each, numerical starter, card conservation", () => {
  for (let i = 0; i < 20; i++) {
    const g = newGame();
    assert.deepEqual(
      g.hands.map((h) => h.length),
      [7, 7],
    );
    assert.equal(g.discard.at(-1)?.kind, "number");
    assert.equal(g.deck.length + g.discard.length + 14, 168);
  }
});
test("illegal moves are rejected without changing state", () => {
  const g = fixture(),
    before = JSON.stringify(g);
  assert.throws(() => play(g, 1, g.hands[1][0]));
  assert.throws(() => play(g, 0, g.hands[0][1]));
  assert.throws(() => act(g, 0, { type: "draw" }));
  assert.equal(JSON.stringify(g), before);
});
test("matching numbers across colors", () => {
  const g = fixture();
  g.hands[0][0] = c("number", "blue", 5);
  play(g, 0, g.hands[0][0]);
  assert.equal(g.turn, 1);
  assert.equal(g.color, "blue");
});
for (const kind of ["skip", "reverse", "skipAll"] as const)
  test(`${kind} grants another turn in 1v1`, () => {
    const g = fixture();
    g.hands[0][0] = c(kind);
    play(g, 0, g.hands[0][0]);
    assert.equal(g.turn, 0);
  });
test("blue skip can be followed by red skip in 1v1 and changes the active color", () => {
  const g = fixture();
  const blueSkip = c("skip", "blue"),
    redSkip = c("skip", "red"),
    redNumber = c("number", "red", 9),
    blueNumber = c("number", "blue", 9);
  g.discard = [c("number", "blue", 5)];
  g.color = "blue";
  g.hands[0] = [blueSkip, redSkip, redNumber, blueNumber];

  play(g, 0, blueSkip);
  assert.equal(g.turn, 0);
  assert.equal(g.color, "blue");
  assert.equal(playable(g, redSkip), true);
  play(g, 0, redSkip);
  assert.equal(g.turn, 0);
  assert.equal(g.color, "red");
  assert.equal(g.discard.at(-1)?.id, redSkip.id);
  assert.equal(playable(g, redNumber), true);
  assert.equal(playable(g, blueNumber), false);
  play(g, 0, redNumber);
  assert.equal(g.turn, 1);
});
for (const n of [0, 7])
  test(`${n} swaps both hands`, () => {
    const g = fixture();
    g.hands[0][0] = c("number", "red", n);
    const ids = g.hands[1].map((c) => c.id);
    play(g, 0, g.hands[0][0]);
    assert.deepEqual(
      g.hands[0].map((c) => c.id),
      ids,
    );
    assert.equal(g.hands[1].length, 1);
    assert.equal(g.vulnerable[1], true);
  });
test("discard all keeps action on top and does not execute discarded effects", () => {
  const g = fixture();
  g.hands[0] = [
    c("discardAll"),
    c("draw4"),
    c("number", "red", 7),
    c("number", "blue", 9),
  ];
  play(g, 0, g.hands[0][0]);
  assert.equal(g.hands[0].length, 1);
  assert.equal(g.discard.at(-1)?.kind, "discardAll");
  assert.equal(g.penalty, 0);
});
test("stacking ignores color, requires equal or greater value, and skips on acceptance", () => {
  const g = fixture();
  g.hands[0] = [c("draw2"), c("number", "blue", 9)];
  g.hands[1] = [c("draw4", "green"), c("number", "yellow", 8)];
  play(g, 0, g.hands[0][0]);
  play(g, 1, g.hands[1][0]);
  assert.equal(g.penalty, 6);
  assert.equal(g.lastPenalty, 4);
  assert.equal(playable(g, c("draw2")), false);
  act(g, 0, { type: "draw" });
  assert.equal(g.hands[0].length, 7);
  assert.equal(g.turn, 1);
  assert.equal(g.penalty, 0);
});
for (const kind of ["draw4", "wild4"] as const)
  test(`${kind}: successful challenge penalizes offender and preserves turn`, () => {
    const g = fixture();
    g.hands[0] = [
      c(kind, kind === "wild4" ? null : "red"),
      c("number", "red", 1),
    ];
    play(g, 0, g.hands[0][0]);
    act(g, 1, { type: "challenge" });
    assert.equal(g.hands[0].length, 5);
    assert.equal(g.hands[1].length, 2);
    assert.equal(g.turn, 1);
    assert.equal(g.penalty, 0);
  });
test("failed +4 challenge draws 6 and skips", () => {
  const g = fixture();
  g.hands[0] = [c("wild4", null), c("number", "blue", 1)];
  play(g, 0, g.hands[0][0]);
  act(g, 1, { type: "challenge" });
  assert.equal(g.hands[1].length, 8);
  assert.equal(g.turn, 0);
});
test("successful challenge on stacked +4 transfers and clears the whole debt", () => {
  const g = fixture();
  g.hands[0] = [c("draw2"), c("number", "blue", 1)];
  g.hands[1] = [c("draw4"), c("number", "red", 1)];
  play(g, 0, g.hands[0][0]);
  play(g, 1, g.hands[1][0]);
  const counts = g.hands.map((hand) => hand.length);
  act(g, 0, { type: "challenge" });
  assert.deepEqual(
    g.hands.map((hand) => hand.length),
    [counts[0], counts[1] + 6],
  );
  assert.deepEqual(g.event?.drawn, [0, 6]);
  assert.equal(g.event?.challengeWon, true);
  assert.equal(g.challenge, null);
  assert.equal(g.penalty, 0);
  assert.equal(g.lastPenalty, 0);
  assert.equal(g.turn, 0);
});
test("failed stacked challenge draws total plus two", () => {
  const g = fixture();
  g.hands[0] = [c("draw2"), c("number", "blue", 1)];
  g.hands[1] = [c("draw4", "green"), c("number", "yellow", 1)];
  play(g, 0, g.hands[0][0]);
  play(g, 1, g.hands[1][0]);
  act(g, 0, { type: "challenge" });
  assert.equal(g.hands[0].length, 9);
  assert.deepEqual(g.event?.drawn, [8, 0]);
  assert.equal(g.event?.challengeWon, false);
  assert.equal(g.penalty, 0);
  assert.equal(g.lastPenalty, 0);
  assert.equal(g.challenge, null);
  assert.equal(g.turn, 1);
});

function stackedTwelve(kind: "draw4" | "wild4", illegal = true): Game {
  const g = fixture();
  const first = c("draw4", "red"),
    second = c("draw4", "green"),
    last = c(kind, kind === "wild4" ? null : "blue");
  g.turn = 1;
  g.hands = [
    [second, c("number", "blue", 9), c("number", "yellow", 8)],
    [first, last, c("number", illegal ? "green" : "yellow", 1)],
  ];
  play(g, 1, first);
  play(g, 0, second);
  play(g, 1, last);
  assert.equal(g.penalty, 12);
  assert.equal(g.lastPenalty, 4);
  assert.equal(g.turn, 0);
  assert.equal(g.challenge?.illegal, illegal);
  return g;
}

for (const kind of ["draw4", "wild4"] as const) {
  test(`${kind}: challenging a 12-card stack successfully draws 0 for A and 12 for B`, () => {
    const g = stackedTwelve(kind);
    const before = g.hands.map((hand) => [...hand]);
    const color = g.color;
    act(g, 0, { type: "challenge" });
    assert.deepEqual(g.hands[0], before[0]);
    assert.equal(g.hands[1].length, before[1].length + 12);
    assert.deepEqual(g.event?.drawn, [0, 12]);
    assert.equal(g.event?.challengeWon, true);
    assert.equal(g.penalty, 0);
    assert.equal(g.lastPenalty, 0);
    assert.equal(g.challenge, null);
    assert.equal(g.turn, 0);
    assert.equal(g.color, color);
    assert.match(g.log.at(-1)!, /全部累计罚抽 12 张/);
    assert.throws(() => act(g, 0, { type: "challenge" }), /当前不能质疑/);
    // A can immediately play an ordinary matching card; no old +8 remains.
    assert.equal(playable(g, g.hands[0][0]), true);
    play(g, 0, g.hands[0][0]);
    assert.equal(g.turn, 1);
    assert.equal(g.penalty, 0);
  });
  test(`${kind}: losing a challenge to a 12-card stack draws 14 for A and 0 for B`, () => {
    const g = stackedTwelve(kind, false);
    const before = g.hands.map((hand) => [...hand]);
    act(g, 0, { type: "challenge" });
    assert.equal(g.hands[0].length, before[0].length + 14);
    assert.deepEqual(g.hands[1], before[1]);
    assert.deepEqual(g.event?.drawn, [14, 0]);
    assert.equal(g.event?.challengeWon, false);
    assert.equal(g.penalty, 0);
    assert.equal(g.lastPenalty, 0);
    assert.equal(g.challenge, null);
    assert.equal(g.turn, 1);
  });
  test(`${kind}: accepting a 12-card stack draws 12 for A without a challenge surcharge`, () => {
    const g = stackedTwelve(kind);
    const before = g.hands.map((hand) => [...hand]);
    act(g, 0, { type: "draw" });
    assert.equal(g.hands[0].length, before[0].length + 12);
    assert.deepEqual(g.hands[1], before[1]);
    assert.deepEqual(g.event?.drawn, [12, 0]);
    assert.equal(g.penalty, 0);
    assert.equal(g.lastPenalty, 0);
    assert.equal(g.challenge, null);
    assert.equal(g.turn, 1);
  });
}
test("a successful whole-stack challenge still observes mercy and clears all debt", () => {
  const g = stackedTwelve("draw4");
  while (g.hands[1].length < 14) g.hands[1].push(c("number", "green", 2));
  const challenger = [...g.hands[0]];
  act(g, 0, { type: "challenge" });
  assert.equal(g.winner, 0);
  assert.equal(g.hands[1].length, 25);
  assert.deepEqual(g.hands[0], challenger);
  assert.deepEqual(g.event?.drawn, [0, 11]);
  assert.equal(g.penalty, 0);
  assert.equal(g.lastPenalty, 0);
  assert.equal(g.challenge, null);
});
test("wilds require valid selected colors before mutation", () => {
  const g = fixture();
  g.hands[0][0] = c("wild6", null);
  const before = JSON.stringify(g);
  assert.throws(() => act(g, 0, { type: "play", cardId: g.hands[0][0].id }));
  assert.equal(JSON.stringify(g), before);
});
test("normal draw stops on playable card; mercy at 25 overrides playability", () => {
  const g = fixture();
  g.hands[0] = [c("number", "blue", 1)];
  g.deck = [c("number", "red", 2), c("number", "green", 3)];
  act(g, 0, { type: "draw" });
  assert.equal(g.hands[0].length, 3);
  assert.equal(g.turn, 0);
  g.hands[0] = Array.from({ length: 24 }, () => c("number", "blue", 1));
  g.deck = [c("number", "red", 2)];
  act(g, 0, { type: "draw" });
  assert.equal(g.winner, 1);
});
test("roulette ignores wilds, takes matching color, skips turn", () => {
  const g = fixture();
  g.hands[0][0] = c("roulette", null);
  g.deck = [c("number", "blue", 1), c("wild6", null), c("number", "green", 2)];
  play(g, 0, g.hands[0][0]);
  act(g, 1, { type: "roulette", color: "blue" });
  assert.equal(g.hands[1].length, 5);
  assert.equal(g.color, "blue");
  assert.equal(g.turn, 0);
  assert.equal(g.roulette, false);
  assert.ok(
    g.log.some(
      (line) => line.includes("轮盘公开翻牌") && line.includes("蓝色 1"),
    ),
  );
});
test("last card wins before swap or penalty effect", () => {
  for (const card of [c("number", "red", 7), c("wild10", null), c("draw4")]) {
    const g = fixture();
    g.hands[0] = [card];
    play(g, 0, card);
    assert.equal(g.winner, 0);
    assert.equal(g.penalty, 0);
  }
});
test("UNO catch, declaration, and next action window", () => {
  const g = fixture();
  play(g, 0, g.hands[0][0]);
  assert.equal(g.vulnerable[0], true);
  act(g, 1, { type: "catch" });
  assert.equal(g.hands[0].length, 3);
  assert.throws(() => act(g, 1, { type: "catch" }));
  const h = fixture();
  act(h, 0, { type: "play", cardId: h.hands[0][0].id, uno: true });
  assert.equal(h.vulnerable[0], false);
  const j = fixture();
  play(j, 0, j.hands[0][0]);
  act(j, 0, { type: "uno" });
  assert.equal(j.vulnerable[0], false);
});
test("reshuffle preserves top card and current color", () => {
  const g = fixture();
  g.hands[0] = [c("number", "blue", 1)];
  g.deck = [];
  const top = g.discard.at(-1)!;
  g.discard.unshift(c("number", "red", 2));
  act(g, 0, { type: "draw" });
  assert.equal(g.discard.at(-1)?.id, top.id);
  assert.equal(g.color, "red");
});
test("120 complete simulated rounds maintain conservation and terminate", () => {
  for (let i = 0; i < 120; i++) {
    const g = newGame(i % 2);
    let steps = 0;
    while (g.winner === null && steps++ < 3000) {
      const p = g.turn;
      if (g.roulette) act(g, p, { type: "roulette", color: "red" });
      else if (g.challenge && steps % 3 === 0) act(g, p, { type: "challenge" });
      else {
        const card = g.hands[p].find((c) => playable(g, c));
        if (card)
          act(g, p, {
            type: "play",
            cardId: card.id,
            color: "blue",
            uno: true,
          });
        else act(g, p, { type: "draw" });
      }
      const all = [...g.deck, ...g.discard, ...g.hands.flat()];
      assert.equal(all.length, 168);
      assert.equal(new Set(all.map((c) => c.id)).size, 168);
      assert.ok(g.hands.every((h) => h.length <= 25));
    }
    assert.notEqual(g.winner, null);
  }
});
test("animation events carry public actions, accurate draw counts, and no private faces", () => {
  const g = fixture();
  g.hands[0] = [c("draw2"), c("number", "blue", 9)];
  const played = g.hands[0][0];
  play(g, 0, played);
  assert.equal(g.event?.id, 1);
  assert.equal(g.event?.card?.id, played.id);
  assert.equal(g.event?.discarded, 1);
  act(g, 1, { type: "draw" });
  assert.equal(g.event?.id, 2);
  assert.deepEqual(g.event?.drawn, [0, 2]);
  assert.equal(g.event?.card, undefined);
  const payload = JSON.stringify(g.event);
  for (const hand of g.hands)
    for (const card of hand) assert.equal(payload.includes(card.id), false);
  const snapshot = JSON.stringify(g.event);
  assert.throws(() => act(g, 1, { type: "draw" }));
  assert.equal(JSON.stringify(g.event), snapshot);
});
test("swap and final-card events describe the resolved effect", () => {
  const g = fixture();
  g.hands[0][0] = c("number", "red", 7);
  play(g, 0, g.hands[0][0]);
  assert.equal(g.event?.swapped, true);
  assert.deepEqual(g.event?.drawn, [0, 0]);
  const h = fixture();
  h.hands[0] = [c("number", "red", 7)];
  play(h, 0, h.hands[0][0]);
  assert.equal(h.event?.swapped, false);
  assert.equal(h.winner, 0);
});
