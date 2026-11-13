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
export type RoomAction =
  Action | { type: "pause" } | { type: "resume" } | { type: "rematch" };

export interface DebugRoundSummary {
  roundId: string;
  round: number;
  startedAt: string;
  finishedAt: string | null;
  entryCount: number;
  complete: boolean;
}
/** Private server state, available only through an explicit debug export. */
export interface DebugGameState {
  roundId: string;
  event: GameEvent | null;
  hands: Card[][];
  deck: Card[];
  discard: Card[];
  color: Color;
  turn: number;
  penalty: number;
  lastPenalty: number;
  challenge: { offender: number; illegal: boolean } | null;
  roulette: boolean;
  winner: number | null;
  reason: string;
  log: string[];
  vulnerable: boolean[];
}
export interface DebugState {
  game: DebugGameState;
  revision: number;
  pausedBy: number | null;
  closed: boolean;
  players: {
    name: string;
    connected: boolean;
    deadline: number | null;
    rematch: boolean;
  }[];
}
export interface DebugAction {
  type: RoomAction["type"];
  cardId?: string;
  color?: Color;
  uno?: boolean;
}
export interface DebugEntry {
  sequence: number;
  at: string;
  actor: number | null;
  kind: "start" | "action" | "disconnect" | "reconnect" | "leave" | "expire";
  action?: DebugAction;
  requestedRevision?: number;
  accepted: boolean;
  error?: string;
  before: DebugState | null;
  after: DebugState;
}
export interface DebugSnapshot {
  schemaVersion: 1;
  kind: "uno-debug-snapshot";
  exportedAt: string;
  server: { appVersion: string; commit: string | null; rulesVersion: string };
  room: string;
  round: DebugRoundSummary;
  players: string[];
  /** Original shuffled deck, before dealing. Cards are drawn from the end. */
  initialDeck: Card[];
  initialDeckTop: "last";
  entries: DebugEntry[];
  current: DebugState;
  complete: boolean;
  recordingError?: string;
}
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
/** A public action and its resolved state, kept for the visual activity log. */
export interface ActivityEntry {
  id: number;
  event: GameEvent | null;
  color: Color;
  turn: number;
  penalty: number;
  previousPenalty?: number;
  roulette: boolean;
  winner: number | null;
  reason: string;
  messages?: string[];
}
export interface PlayerView {
  name: string;
  connected: boolean;
  count: number;
  deadline: number | null;
  rematch: boolean;
}
export interface View {
  activity?: ActivityEntry[];
  debugRounds?: DebugRoundSummary[];
  roundId: string | null;
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
  | { ok: true; room?: string; token?: string; snapshot?: DebugSnapshot }
  | { ok: false; error: string };
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
