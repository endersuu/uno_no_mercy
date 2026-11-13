import { randomInt, randomUUID } from "node:crypto";
import {
  COLORS,
  colorNames,
  kindNames,
  type Action,
  type Card,
  type Color,
  type GameEvent,
} from "../shared/types.js";
export interface Game {
  roundId: string;
  event: GameEvent | null;
  hands: Card[][];
  deck: Card[];
  discard: Card[];
  color: Color;
  turn: number;
  penalty: number;
  lastPenalty: number;
  challenge: null | {
    offender: number;
    illegal: boolean;
  };
  roulette: boolean;
  winner: number | null;
  reason: string;
  log: string[];
  vulnerable: boolean[];
}
export function shuffle<T>(cards: T[]): T[] {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}
export function deck(): Card[] {
  const cards: Card[] = [];
  const add = (
    color: Color | null,
    kind: Card["kind"],
    n: number,
    value?: number,
  ) => {
    for (let i = 0; i < n; i++)
      cards.push({
        id: randomUUID(),
        color,
        kind,
        ...(value === undefined ? {} : { value }),
      });
  };
  for (const color of COLORS) {
    for (let v = 0; v < 10; v++) add(color, "number", 2, v);
    for (const k of ["skip", "reverse", "draw2", "discardAll"] as const)
      add(color, k, 3);
    add(color, "draw4", 2);
    add(color, "skipAll", 2);
  }
  add(null, "wild4", 8);
  add(null, "wild6", 4);
  add(null, "wild10", 4);
  add(null, "roulette", 8);
  return cards;
}
export function newGame(
  turn = 0,
  captureInitialDeck?: (cards: Card[]) => void,
): Game {
  const pile = shuffle(deck()),
    hands = [[], []] as Card[][];
  captureInitialDeck?.([...pile]);
  for (let i = 0; i < 7; i++) for (const hand of hands) hand.push(pile.pop()!);
  const discard: Card[] = [];
  do {
    discard.push(pile.pop()!);
  } while (discard.at(-1)!.kind !== "number");
  return {
    roundId: randomUUID(),
    event: null,
    hands,
    deck: pile,
    discard,
    color: discard.at(-1)!.color!,
    turn,
    penalty: 0,
    lastPenalty: 0,
    challenge: null,
    roulette: false,
    winner: null,
    reason: "",
    log: ["新一局开始，每人 7 张牌。"],
    vulnerable: [false, false],
  };
}
export function amount(c: Card): number {
  return (
    (
      { draw2: 2, draw4: 4, wild4: 4, wild6: 6, wild10: 10 } as Partial<
        Record<Card["kind"], number>
      >
    )[c.kind] ?? 0
  );
}
export function playable(g: Game, c: Card): boolean {
  if (g.roulette || g.winner !== null) return false;
  if (g.penalty) return amount(c) >= g.lastPenalty;
  const top = g.discard.at(-1)!;
  return (
    !c.color ||
    c.color === g.color ||
    (c.kind === top.kind && (c.kind !== "number" || c.value === top.value))
  );
}
function note(g: Game, text: string) {
  g.log.push(text);
  g.log = g.log.slice(-12);
}
function win(g: Game, p: number, reason: string) {
  g.winner = p;
  g.reason = reason;
  g.challenge = null;
  g.roulette = false;
  g.penalty = 0;
}
function take(g: Game, p: number): Card | undefined {
  if (!g.deck.length) {
    const top = g.discard.pop()!;
    g.deck = shuffle(g.discard);
    g.discard = [top];
  }
  const c = g.deck.pop();
  if (!c) return;
  g.hands[p].push(c);
  g.vulnerable[p] = false;
  if (g.hands[p].length >= 25)
    win(g, 1 - p, "对手达到 25 张手牌，触发 Mercy 淘汰。");
  return c;
}
function takeMany(g: Game, p: number, n: number) {
  for (let i = 0; i < n && g.winner === null; i++) if (!take(g, p)) break;
}
export function act(g: Game, p: number, a: Action): void {
  const allHeldIds = new Set(g.hands.flat().map((c) => c.id));
  const card =
    a.type === "play" ? g.hands[p].find((c) => c.id === a.cardId) : undefined;
  const previousCount = g.hands[p].length;
  const challengeWon = g.challenge?.illegal;
  applyAction(g, p, a);
  const swapped =
    !!card &&
    card.kind === "number" &&
    (card.value === 0 || card.value === 7) &&
    g.winner === null;
  g.event = {
    id: (g.event?.id ?? 0) + 1,
    action: a.type,
    actor: p,
    ...(card ? { card } : {}),
    drawn: g.hands.map(
      (hand) => hand.filter((c) => !allHeldIds.has(c.id)).length,
    ),
    swapped,
    discarded:
      a.type === "play" && !swapped ? previousCount - g.hands[p].length : 0,
    ...(a.type === "challenge" ? { challengeWon } : {}),
    declaredUno:
      a.type === "uno" ||
      (a.type === "play" && !!a.uno && g.hands[p].length === 1),
  };
}
function applyAction(g: Game, p: number, a: Action): void {
  if (g.winner !== null) throw Error("本局已经结束。");
  if (a.type === "uno") {
    if (g.hands[p].length !== 1) throw Error("只剩一张牌时才能喊 UNO。");
    g.vulnerable[p] = false;
    note(g, `玩家 ${p + 1} 喊了 UNO！`);
    return;
  }
  if (a.type === "catch") {
    if (!g.vulnerable[1 - p]) throw Error("对手没有漏喊 UNO。");
    takeMany(g, 1 - p, 2);
    g.vulnerable[1 - p] = false;
    note(g, `抓到漏喊 UNO！玩家 ${2 - p} 罚抽 2 张。`);
    return;
  }
  if (g.turn !== p) throw Error("还没轮到你。");
  if (a.type === "challenge") {
    const c = g.challenge;
    if (!c) throw Error("当前不能质疑。");
    g.vulnerable[1 - p] = false;
    const total = g.penalty;
    g.challenge = null;
    // A challenge settles the entire stack, regardless of its outcome.
    g.penalty = 0;
    g.lastPenalty = 0;
    if (c.illegal) {
      takeMany(g, c.offender, total);
      note(
        g,
        `质疑成功：出牌者仍有原颜色牌，承担全部累计罚抽 ${total} 张。你无需抽牌，罚抽已清零。${g.winner === null ? "你的回合继续。" : "本局结束。"}`,
      );
    } else {
      const n = total + 2;
      takeMany(g, p, n);
      g.turn = 1 - p;
      note(g, `质疑失败：罚抽 ${n} 张，跳过回合。`);
    }
    return;
  }
  if (g.roulette) {
    if (a.type !== "roulette" || !COLORS.includes(a.color))
      throw Error("请先选择轮盘颜色。");
    g.vulnerable[1 - p] = false;
    g.color = a.color;
    const revealed: string[] = [];
    let n = 0;
    while (g.winner === null) {
      const c = take(g, p);
      if (!c) break;
      n++;
      revealed.push(
        `${c.color ? colorNames[c.color] : "万能"} ${c.kind === "number" ? c.value : kindNames[c.kind]}`,
      );
      if (c.color === a.color) break;
    }
    if (revealed.length) note(g, `轮盘公开翻牌：${revealed.join(" → ")}`);
    g.roulette = false;
    g.turn = 1 - p;
    note(
      g,
      `玩家 ${p + 1} 选择${colorNames[a.color]}，轮盘抽取 ${n} 张，跳过回合。`,
    );
    return;
  }
  if (a.type === "draw") {
    if (!g.penalty && g.hands[p].some((c) => playable(g, c)))
      throw Error("有可出的牌，请先出牌。");
    g.vulnerable[1 - p] = false;
    g.challenge = null;
    if (g.penalty) {
      const n = g.penalty;
      takeMany(g, p, n);
      g.penalty = 0;
      g.lastPenalty = 0;
      g.turn = 1 - p;
      note(g, `玩家 ${p + 1} 接受罚抽 ${n} 张，跳过回合。`);
      return;
    }
    let n = 0;
    while (g.winner === null) {
      const c = take(g, p);
      if (!c) {
        g.turn = 1 - p;
        break;
      }
      n++;
      if (playable(g, c)) break;
    }
    note(g, `玩家 ${p + 1} 抽了 ${n} 张牌。`);
    return;
  }
  if (a.type !== "play") throw Error("无效操作。");
  const card = g.hands[p].find((c) => c.id === a.cardId);
  if (!card || !playable(g, card)) throw Error("这张牌现在不能出。");
  if (
    !card.color &&
    card.kind !== "roulette" &&
    (!a.color || !COLORS.includes(a.color))
  )
    throw Error("请选择有效的颜色。");
  const illegal = g.hands[p].some(
    (c) => c.id !== card.id && c.color === g.color,
  );
  const previous = g.penalty;
  g.vulnerable[1 - p] = false;
  g.challenge = null;
  g.hands[p] = g.hands[p].filter((c) => c.id !== card.id);
  if (card.kind === "discardAll") {
    const extra = g.hands[p].filter((c) => c.color === card.color);
    g.hands[p] = g.hands[p].filter((c) => c.color !== card.color);
    g.discard.push(...extra);
  }
  g.discard.push(card);
  if (card.color) g.color = card.color;
  else if (card.kind !== "roulette" && a.color) g.color = a.color;
  note(
    g,
    `玩家 ${p + 1} 打出${card.color ? colorNames[card.color] : ""}${card.kind === "number" ? card.value : kindNames[card.kind]}。`,
  );
  if (!g.hands[p].length) {
    win(g, p, "率先出完所有手牌。");
    return;
  }
  g.turn = 1 - p;
  if (card.kind === "number" && (card.value === 7 || card.value === 0)) {
    [g.hands[0], g.hands[1]] = [g.hands[1], g.hands[0]];
    g.vulnerable = g.hands.map((h) => h.length === 1);
    note(g, "双方交换了全部手牌。");
  } else {
    g.vulnerable[p] = g.hands[p].length === 1 && !a.uno;
  }
  if (a.uno && g.hands[p].length === 1) {
    g.vulnerable[p] = false;
    note(g, `玩家 ${p + 1} 喊了 UNO！`);
  }
  if (["skip", "reverse", "skipAll"].includes(card.kind)) g.turn = p;
  if (amount(card)) {
    g.penalty = previous + amount(card);
    g.lastPenalty = amount(card);
    if (amount(card) === 4) g.challenge = { offender: p, illegal };
  }
  if (card.kind === "roulette") g.roulette = true;
}
