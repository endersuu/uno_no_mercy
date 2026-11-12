import { randomBytes } from "node:crypto";
import { act, newGame, playable, type Game } from "./game.js";
import type { Action, View } from "../shared/types.js";
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
export class Rooms {
  rooms = new Map<string, Room>();
  constructor(
    private emit: (socket: string, v: View) => void,
    private grace = 60_000,
    private now = () => Date.now(),
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
      s.socket = socket;
      s.deadline = null;
      if (!r.game && r.seats.every((s) => s?.socket))
        r.game = newGame(r.round % 2);
      this.publish(r);
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
    if (r.seats.every((s) => s?.socket)) r.game = newGame(r.round % 2);
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
  update(
    socket: string,
    revision: number,
    action:
      Action | { type: "pause" } | { type: "resume" } | { type: "rematch" },
  ) {
    const { r, p } = this.find(socket);
    if (revision !== r.revision) throw Error("状态已更新，请重新操作。");
    if (r.closed) throw Error("有玩家已离开，请创建新房间。");
    if (action.type === "rematch") {
      if (!r.game || r.game.winner === null) throw Error("本局还未结束。");
      if (r.seats.some((s) => !s?.socket))
        throw Error("等待对手重连后再来一局。");
      r.seats[p]!.rematch = true;
      if (r.seats.every((s) => s?.rematch && s.socket)) {
        r.round++;
        r.game = newGame(r.round % 2);
        r.pausedBy = null;
        r.seats.forEach((s) => {
          s!.rematch = false;
        });
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
    this.publish(r);
  }
  disconnect(socket: string) {
    try {
      const { r, p } = this.find(socket);
      r.seats[p]!.socket = null;
      r.seats[p]!.deadline = this.now() + this.grace;
      this.publish(r);
    } catch {}
  }
  leave(socket: string) {
    const { r, p } = this.find(socket);
    this.remove(r, p, "对手离开了房间，本局结束。");
  }
  private remove(r: Room, p: number, reason: string) {
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
      this.rooms.delete(r.id);
      return;
    }
    this.publish(r);
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
          this.remove(r, p, "对手断线超过一分钟，本局结束。");
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
  private publish(r: Room) {
    r.revision++;
    r.seats.forEach((s, p) => {
      if (s?.socket) this.emit(s.socket, this.view(r, p));
    });
  }
}
