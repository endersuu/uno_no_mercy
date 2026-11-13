import { randomBytes } from "node:crypto";
import { act, newGame, playable, type Game } from "./game.js";
import { DebugRecords } from "./debug-records.js";
import { COLORS } from "../shared/types.js";
import type {
  Card,
  DebugEntry,
  DebugState,
  RoomAction,
  View,
} from "../shared/types.js";
interface Seat {
  token: string;
  socket: string | null;
  name: string;
  deadline: number | null;
  rematch: boolean;
}
interface Room {
  id: string;
  seats: (Seat | null)[];
  game: Game | null;
  pausedBy: number | null;
  revision: number;
  closed: boolean;
  round: number;
}
type Audit = Pick<
  DebugEntry,
  "kind" | "actor" | "action" | "before" | "requestedRevision"
>;
export class Rooms {
  rooms = new Map<string, Room>();
  constructor(
    private emit: (socket: string, v: View) => void,
    private grace = 60_000,
    private now = () => Date.now(),
    private debug = new DebugRecords(),
  ) {}
  create(socket: string, name: string) {
    if (this.rooms.size >= 1000) throw Error("房间已满，请稍后再试。");
    const id = randomBytes(9).toString("base64url");
    const r: Room = {
      id,
      seats: [null, null],
      game: null,
      pausedBy: null,
      revision: 0,
      closed: false,
      round: 0,
    };
    this.rooms.set(id, r);
    return this.join(id, socket, name);
  }
  join(id: string, socket: string, name: string, token?: string) {
    const r = this.rooms.get(id);
    if (!r) throw Error("房间不存在或已销毁，请创建新房间。");
    const old = r.seats.findIndex((s) => !!s && !!token && s.token === token);
    if (old >= 0) {
      const s = r.seats[old]!;
      if (s.deadline !== null && s.deadline <= this.now()) {
        this.expire();
        throw Error("重连已超过一分钟。");
      }
      if (s.socket && s.socket !== socket)
        throw Error("这个席位已在另一个页面连接。");
      const before = this.debugState(r);
      s.socket = socket;
      s.deadline = null;
      if (!r.game && r.seats.every((s) => s?.socket)) this.startRound(r);
      this.publish(
        r,
        before ? { kind: "reconnect", actor: old, before } : undefined,
      );
      return { room: id, token: s.token };
    }
    if (r.closed || r.game) throw Error("房间已经开始或结束，不能加入。");
    const p = r.seats.findIndex((s) => !s);
    if (p < 0) throw Error("房间已有两位玩家。");
    const s: Seat = {
      token: randomBytes(24).toString("base64url"),
      socket,
      name: name.trim().slice(0, 16) || `玩家 ${p + 1}`,
      deadline: null,
      rematch: false,
    };
    r.seats[p] = s;
    if (r.seats.every((s) => s?.socket)) this.startRound(r);
    this.publish(r);
    return { room: id, token: s.token };
  }
  find(socket: string): { r: Room; p: number } {
    for (const r of this.rooms.values()) {
      const p = r.seats.findIndex((s) => s?.socket === socket);
      if (p >= 0) return { r, p };
    }
    throw Error("请先加入房间。");
  }
  update(socket: string, revision: number, action: RoomAction) {
    const { r, p } = this.find(socket);
    const before = this.debugState(r);
    const audit: Audit = {
      kind: "action",
      actor: p,
      action: this.debugAction(action),
      before,
      requestedRevision: revision,
    };
    try {
      if (revision !== r.revision) throw Error("状态已更新，请重新操作。");
      if (r.closed) throw Error("有玩家已离开，请创建新房间。");
      if (
        action.type === "play" &&
        (typeof action.cardId !== "string" ||
          action.cardId.length > 64 ||
          (action.uno !== undefined && typeof action.uno !== "boolean"))
      )
        throw Error("无效牌。");
      if (
        "color" in action &&
        action.color !== undefined &&
        !COLORS.includes(action.color)
      )
        throw Error("请选择有效颜色。");
      if (action.type === "rematch") {
        if (!r.game || r.game.winner === null) throw Error("本局还未结束。");
        if (r.seats.some((s) => !s?.socket))
          throw Error("等待对手重连后再来一局。");
        r.seats[p]!.rematch = true;
        if (r.seats.every((s) => s?.rematch && s.socket)) {
          // The final vote belongs to the old round, before the new deal replaces it.
          this.record(r, audit, true, undefined, r.revision + 1);
          r.round++;
          r.pausedBy = null;
          r.seats.forEach((s) => {
            s!.rematch = false;
          });
          this.startRound(r);
          this.publish(r);
          return;
        }
      } else {
        if (!r.game || r.game.winner !== null) throw Error("当前不在对局中。");
        if (action.type === "pause") {
          if (r.pausedBy === null) r.pausedBy = p;
        } else if (action.type === "resume") {
          if (r.pausedBy !== p) throw Error("请等待发起暂停的玩家继续。");
          r.pausedBy = null;
        } else {
          if (r.pausedBy !== null || r.seats.some((s) => !s?.socket))
            throw Error("游戏已暂停。");
          act(r.game, p, action);
        }
      }
    } catch (error) {
      this.record(
        r,
        audit,
        false,
        error instanceof Error ? error.message : "操作失败。",
      );
      throw error;
    }
    this.publish(r, audit);
  }
  disconnect(socket: string) {
    try {
      const { r, p } = this.find(socket);
      const before = this.debugState(r);
      r.seats[p]!.socket = null;
      r.seats[p]!.deadline = this.now() + this.grace;
      this.publish(
        r,
        before ? { kind: "disconnect", actor: p, before } : undefined,
      );
    } catch {}
  }
  leave(socket: string) {
    const { r, p } = this.find(socket);
    this.remove(r, p, "对手离开了房间，本局结束。", "leave");
  }
  private remove(r: Room, p: number, reason: string, kind: "leave" | "expire") {
    const before = this.debugState(r);
    r.seats[p] = null;
    if (r.game) {
      if (r.game.winner === null) {
        r.game.winner = 1 - p;
        r.game.reason = reason;
      }
      r.closed = true;
      r.pausedBy = null;
    }
    if (r.seats.every((s) => !s)) {
      if (before)
        this.record(
          r,
          { kind, actor: p, before },
          true,
          undefined,
          r.revision + 1,
        );
      this.rooms.delete(r.id);
      this.debug.deleteRoom(r.id);
      return;
    }
    this.publish(r, before ? { kind, actor: p, before } : undefined);
  }
  expire() {
    for (const r of this.rooms.values())
      for (let p = 0; p < 2; p++) {
        const s = r.seats[p];
        if (
          s?.deadline !== null &&
          s?.deadline !== undefined &&
          s.deadline <= this.now()
        )
          this.remove(r, p, "对手断线超过一分钟，本局结束。", "expire");
      }
  }
  view(r: Room, p: number): View {
    const g = r.game,
      active =
        !!g &&
        g.winner === null &&
        r.pausedBy === null &&
        r.seats.every((s) => s?.socket);
    return {
      debugRounds: this.debug.summaries(r.id),
      roundId: g?.roundId ?? null,
      event: g?.event ?? null,
      room: r.id,
      revision: r.revision,
      me: p,
      players: r.seats.map((s, i) => ({
        name: s?.name ?? "等待玩家",
        connected: !!s?.socket,
        count: g?.hands[i]?.length ?? 0,
        deadline: s?.deadline ?? null,
        rematch: s?.rematch ?? false,
      })),
      phase: !g ? "waiting" : g.winner !== null ? "finished" : "playing",
      hand: g?.hands[p] ?? [],
      top: g?.discard.at(-1) ?? null,
      color: g?.color ?? null,
      turn: g?.turn ?? 0,
      playable:
        active && g!.turn === p
          ? g!.hands[p].filter((c) => playable(g!, c)).map((c) => c.id)
          : [],
      penalty: g?.penalty ?? 0,
      lastPenalty: g?.lastPenalty ?? 0,
      challenge: !!g?.challenge && g.turn === p,
      roulette: !!g?.roulette && g.turn === p,
      winner: g?.winner ?? null,
      reason: g?.reason ?? "",
      pausedBy: r.pausedBy,
      disconnected: r.seats.some((s) => !!s && !s.socket),
      log: g?.log ?? [],
      canCatch: !!g?.vulnerable[1 - p],
      unoNeeded: !!g?.vulnerable[p],
      closed: r.closed,
    };
  }
  debugSnapshot(socket: string, roundId?: string) {
    const { r } = this.find(socket);
    const selected = roundId ?? r.game?.roundId;
    if (!selected) throw Error("对局尚未开始，暂无调试记录。");
    return this.debug.export(
      r.id,
      selected,
      this.timestamp(),
      selected === r.game?.roundId ? this.debugState(r)! : undefined,
    );
  }
  private timestamp() {
    return new Date(this.now()).toISOString();
  }
  private startRound(r: Room) {
    let initialDeck: Card[] = [];
    r.game = newGame(r.round % 2, (cards) => {
      initialDeck = cards;
    });
    this.debug.start(
      r.id,
      r.round + 1,
      initialDeck,
      this.debugState(r, r.revision + 1)!,
      this.timestamp(),
    );
  }
  private debugState(r: Room, revision = r.revision): DebugState | null {
    if (!r.game) return null;
    const {
      roundId,
      event,
      hands,
      deck,
      discard,
      color,
      turn,
      penalty,
      lastPenalty,
      challenge,
      roulette,
      winner,
      reason,
      log,
      vulnerable,
    } = r.game;
    return structuredClone({
      game: {
        roundId,
        event,
        hands,
        deck,
        discard,
        color,
        turn,
        penalty,
        lastPenalty,
        challenge,
        roulette,
        winner,
        reason,
        log,
        vulnerable,
      },
      revision,
      pausedBy: r.pausedBy,
      closed: r.closed,
      players: r.seats.map((s) => ({
        name: s?.name ?? "等待玩家",
        connected: !!s?.socket,
        deadline: s?.deadline ?? null,
        rematch: s?.rematch ?? false,
      })),
    });
  }
  private debugAction(action: RoomAction): DebugEntry["action"] {
    const safe: NonNullable<DebugEntry["action"]> = { type: action.type };
    if (action.type === "play") {
      if (typeof action.cardId === "string" && action.cardId.length <= 64)
        safe.cardId = action.cardId;
      if (typeof action.uno === "boolean") safe.uno = action.uno;
    }
    if (
      (action.type === "play" || action.type === "roulette") &&
      COLORS.includes(action.color!)
    )
      safe.color = action.color;
    return safe;
  }
  private record(
    r: Room,
    audit: Audit,
    accepted: boolean,
    error?: string,
    revision = r.revision,
  ) {
    const after = this.debugState(r, revision);
    if (!after || !audit.before) return;
    this.debug.append(r.id, audit.before.game.roundId, {
      ...audit,
      at: this.timestamp(),
      accepted,
      ...(error ? { error } : {}),
      after,
    });
  }
  private publish(r: Room, audit?: Audit) {
    r.revision++;
    if (audit) this.record(r, audit, true);
    r.seats.forEach((s, p) => {
      if (s?.socket) this.emit(s.socket, this.view(r, p));
    });
  }
}
