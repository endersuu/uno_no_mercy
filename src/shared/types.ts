export const COLORS = ["red", "yellow", "green", "blue"] as const;
export type Color = (typeof COLORS)[number];
export type Kind =
  | "number"
  | "skip"
  | "reverse"
  | "draw2"
  | "draw4"
  | "discardAll"
  | "skipAll"
  | "wild4"
  | "wild6"
  | "wild10"
  | "roulette";
export interface Card {
  id: string;
  color: Color | null;
  kind: Kind;
  value?: number;
}
export type Action =
  | { type: "play"; cardId: string; color?: Color; uno?: boolean }
  | { type: "draw" | "challenge" | "uno" | "catch" }
  | { type: "roulette"; color: Color };
/** Public action facts only: never include drawn faces or private hands. */
export interface GameEvent {
  id: number;
  action: Action["type"];
  actor: number;
  card?: Card;
  drawn: number[];
  swapped: boolean;
  discarded: number;
  challengeWon?: boolean;
  declaredUno: boolean;
}
export interface PlayerView {
  name: string;
  connected: boolean;
  count: number;
  deadline: number | null;
  rematch: boolean;
}
export interface View {
  event: GameEvent | null;
  room: string;
  revision: number;
  me: number;
  players: PlayerView[];
  phase: "waiting" | "playing" | "finished";
  hand: Card[];
  top: Card | null;
  color: Color | null;
  turn: number;
  playable: string[];
  penalty: number;
  lastPenalty: number;
  challenge: boolean;
  roulette: boolean;
  winner: number | null;
  reason: string;
  pausedBy: number | null;
  disconnected: boolean;
  log: string[];
  canCatch: boolean;
  unoNeeded: boolean;
  closed: boolean;
}
export type Reply =
  { ok: true; room?: string; token?: string } | { ok: false; error: string };
export const colorNames: Record<Color, string> = {
  red: "红色",
  yellow: "黄色",
  green: "绿色",
  blue: "蓝色",
};
export const kindNames: Record<Kind, string> = {
  number: "数字",
  skip: "跳过",
  reverse: "反转",
  draw2: "抽二",
  draw4: "抽四",
  discardAll: "全弃",
  skipAll: "跳过所有人",
  wild4: "反转 +4",
  wild6: "万能 +6",
  wild10: "万能 +10",
  roulette: "颜色轮盘",
};
export function face(c: Card): string {
  return c.kind === "number"
    ? String(c.value)
    : {
        skip: "⊘",
        reverse: "⇄",
        draw2: "+2",
        draw4: "+4",
        discardAll: "⇊",
        skipAll: "≫",
        wild4: "+4",
        wild6: "+6",
        wild10: "+10",
        roulette: "◉",
      }[c.kind];
}
