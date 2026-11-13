import { test } from "node:test";
import assert from "node:assert/strict";
import { activityMarkup, describeActivity } from "../src/client/activity.js";
import type {
  ActivityEntry,
  Card,
  GameEvent,
  View,
} from "../src/shared/types.js";

const viewer: Pick<View, "me" | "players"> = {
  me: 0,
  players: ["Alice", "Bob"].map((name) => ({
    name,
    connected: true,
    count: 7,
    deadline: null,
    rematch: false,
  })),
};
function event(extra: Partial<GameEvent> = {}): GameEvent {
  return {
    id: 1,
    action: "play",
    actor: 0,
    drawn: [0, 0],
    swapped: false,
    discarded: 1,
    declaredUno: false,
    ...extra,
  };
}
function entry(
  e: GameEvent,
  extra: Partial<ActivityEntry> = {},
): ActivityEntry {
  return {
    id: e.id,
    event: e,
    color: "red",
    turn: 1,
    penalty: 0,
    previousPenalty: 0,
    roulette: false,
    winner: null,
    reason: "",
    ...extra,
  };
}
const card = (kind: Card["kind"], value?: number): Card => ({
  id: `public-${kind}-${value ?? "action"}`,
  color: kind.startsWith("wild") ? null : "red",
  kind,
  ...(value === undefined ? {} : { value }),
});
function view(activity: ActivityEntry[], extra: Partial<View> = {}): View {
  return {
    ...viewer,
    activity,
    room: "activity-room",
    roundId: "activity-round",
    revision: 1,
    event: null,
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
    ...extra,
  };
}

test("a historical wild draw uses its captured color and stack, even after the current stack is cleared", () => {
  const played = entry(event({ card: card("wild4") }), {
    color: "blue",
    penalty: 12,
    previousPenalty: 8,
  });
  const before = structuredClone(played);
  const feedback = describeActivity(played, viewer);
  assert.match(feedback.detail, /选择蓝色/);
  assert.match(feedback.detail, /累计罚抽 \+12/);
  assert.match(feedback.detail, /Bob.*可以叠加/);
  assert.match(feedback.detail, /可以质疑/);
  const html = activityMarkup(view([played], { penalty: 0, color: "yellow" }));
  assert.match(html, /累计罚抽 \+12/);
  assert.match(html, /选择蓝色/);
  assert.doesNotMatch(html, /选择黄色/);
  assert.deepEqual(played, before);
});

test("skip and hand swaps describe the resolved next player, including both swap numbers", () => {
  const skip = describeActivity(
    entry(event({ card: card("skip") }), { turn: 0 }),
    viewer,
  );
  assert.match(skip.detail, /跳过 Bob/);
  assert.match(skip.detail, /你 再出一张/);
  for (const value of [0, 7]) {
    const swap = describeActivity(
      entry(event({ card: card("number", value), swapped: true })),
      viewer,
    );
    assert.match(swap.detail, /双方交换了全部手牌/);
    assert.match(swap.detail, /轮到 Bob/);
    assert.doesNotMatch(swap.detail, /再出一张/);
  }
});

test("discard all shows its total, while a winning last card never claims an unexecuted penalty, skip, or swap", () => {
  const discard = describeActivity(
    entry(event({ card: card("discardAll"), discarded: 5 })),
    viewer,
  );
  assert.match(discard.detail, /共打出 5 张/);
  for (const played of [card("skip"), card("wild10"), card("number", 0)]) {
    const finished = describeActivity(
      entry(event({ card: played }), {
        winner: 0,
        reason: "率先出完所有手牌。",
      }),
      viewer,
    );
    assert.match(finished.detail, /你出完所有手牌，获胜/);
    assert.doesNotMatch(finished.detail, /累计罚抽|再出一张|交换了全部手牌/);
  }
});

test("challenges show the actual full-stack settlement and Mercy does not claim more cards than were drawn", () => {
  const won = describeActivity(
    entry(
      event({
        action: "challenge",
        drawn: [0, 12],
        discarded: 0,
        challengeWon: true,
      }),
      { turn: 0, previousPenalty: 12 },
    ),
    viewer,
  );
  assert.match(won.detail, /Bob承担全部累计罚抽，实际抽 12 张/);
  assert.match(won.detail, /你抽 0 张/);
  assert.match(won.detail, /罚抽已清零/);
  assert.match(won.detail, /你继续出牌/);
  const lost = describeActivity(
    entry(
      event({
        action: "challenge",
        drawn: [14, 0],
        discarded: 0,
        challengeWon: false,
      }),
      { previousPenalty: 12 },
    ),
    viewer,
  );
  assert.match(lost.detail, /你实际抽 14 张/);
  assert.match(lost.detail, /跳过 你 的回合/);
  const mercy = describeActivity(
    entry(
      event({
        action: "challenge",
        drawn: [11, 0],
        discarded: 0,
        challengeWon: false,
      }),
      { previousPenalty: 12, winner: 1 },
    ),
    viewer,
  );
  assert.match(mercy.detail, /你实际抽 11 张/);
  assert.match(mercy.detail, /你达到 25 张手牌，Bob获胜/);
  assert.doesNotMatch(mercy.detail, /抽 14 张|继续出牌|跳过/);
});

test("normal draws, accepted penalties and a Mercy UNO catch keep their actual counts and effects distinct", () => {
  const drawn = describeActivity(
    entry(event({ action: "draw", drawn: [3, 0], discarded: 0 }), { turn: 0 }),
    viewer,
  );
  assert.match(drawn.title, /抽了 3 张牌/);
  assert.match(drawn.detail, /继续出牌/);
  assert.doesNotMatch(drawn.detail, /罚抽/);
  const accepted = describeActivity(
    entry(event({ action: "draw", drawn: [8, 0], discarded: 0 }), {
      previousPenalty: 8,
    }),
    viewer,
  );
  assert.match(accepted.title, /接受罚抽/);
  assert.match(accepted.detail, /累计罚抽 8 张，实际抽 8 张/);
  assert.match(accepted.detail, /跳过/);
  const caught = describeActivity(
    entry(event({ action: "catch", drawn: [0, 1], discarded: 0 }), {
      winner: 0,
    }),
    viewer,
  );
  assert.match(caught.detail, /Bob罚抽 1 张/);
  assert.match(caught.detail, /Bob达到 25 张手牌，你获胜/);
  assert.doesNotMatch(caught.detail, /罚抽 2 张/);
});

test("activity markup escapes names and fallback logs and never turns a private draw into a card face", () => {
  const unsafeName = '<img src=x onerror="alert(1)">';
  const ordinaryDraw = entry(
    event({ action: "draw", actor: 1, drawn: [0, 3], discarded: 0 }),
    { turn: 1 },
  );
  const drawnView = view([ordinaryDraw], {
    players: [viewer.players[0], { ...viewer.players[1], name: unsafeName }],
    hand: [
      {
        id: "private-card-never-rendered",
        kind: "number",
        color: "green",
        value: 9,
      },
    ],
  });
  const drawnMarkup = activityMarkup(drawnView);
  assert.match(drawnMarkup, /&lt;img/);
  assert.doesNotMatch(
    drawnMarkup,
    /<img|private-card-never-rendered|card-art|data-card=/,
  );
  const playedMarkup = activityMarkup(
    view([entry(event({ card: card("skip") }))]),
  );
  assert.match(playedMarkup, /card-art/);
  assert.doesNotMatch(playedMarkup, /<button|data-card=/);
  const fallback = activityMarkup(view([], { log: [unsafeName] }));
  assert.match(fallback, /&lt;img/);
  assert.doesNotMatch(fallback, /<img/);
});
