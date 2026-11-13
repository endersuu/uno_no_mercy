import express from "express";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Server } from "socket.io";
import { resolve } from "node:path";
import { Rooms } from "./rooms.js";
import { AbuseGuard, clientIp } from "./abuse.js";
import type { Action, Reply } from "../shared/types.js";
const trustedProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
if (
  !Number.isInteger(trustedProxyHops) ||
  trustedProxyHops < 0 ||
  trustedProxyHops > 8
)
  throw Error("TRUST_PROXY_HOPS must be an integer between 0 and 8.");
// Until Render's proxy topology is verified, enforce global limits there rather
// than accidentally counting all players as one reverse-proxy IP.
const identify = (req: Parameters<typeof clientIp>[0]) =>
  process.env.RENDER === "true" && trustedProxyHops === 0
    ? null
    : clientIp(req, trustedProxyHops);
const guard = new AbuseGuard();
const reservations = new WeakMap<
  Parameters<typeof clientIp>[0],
  { release: () => void; timeout: NodeJS.Timeout; ip: string | null }
>();
const app = express(),
  http = createServer(app),
  io = new Server(http, {
    maxHttpBufferSize: 8192,
    connectTimeout: 10_000,
    allowRequest(req, done) {
      const ip = identify(req);
      if (!guard.take("handshake", ip)) {
        done("连接太频繁，请稍后再试。", false);
        return;
      }
      const release = guard.acquire(ip);
      if (!release) {
        done("服务器连接已满，请稍后再试。", false);
        return;
      }
      // Failed/incomplete handshakes must not permanently consume capacity.
      const timeout = setTimeout(() => {
        reservations.delete(req);
        release();
      }, 10_000);
      timeout.unref();
      reservations.set(req, { release, timeout, ip });
      done(null, true);
    },
  });
http.headersTimeout = 10_000;
http.requestTimeout = 15_000;
http.keepAliveTimeout = 5000;
http.maxHeadersCount = 64;
http.maxConnections = 512;
const httpBudget = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => {
  if (guard.take("http", identify(req))) next();
  else {
    res.setHeader("Retry-After", "60");
    res.statusCode = 429;
    res.end("Too many requests. Please try again later.");
  }
};
app.disable("x-powered-by");
app.get("/health", (_req, res) => res.json({ ok: true }));
app.use(httpBudget);
// Engine.IO handles its own route before Express, including polling requests.
io.engine.use(httpBudget);
const rooms = new Rooms((id, v) => io.to(id).emit("state", v));
setInterval(() => rooms.expire(), 500).unref();
setInterval(() => guard.prune(), 30_000).unref();
io.engine.on("connection_error", ({ req }: { req: IncomingMessage }) => {
  const reservation = reservations.get(req);
  if (reservation) {
    clearTimeout(reservation.timeout);
    reservations.delete(req);
    reservation.release();
  }
});
io.engine.on("connection", (connection) => {
  const reservation = reservations.get(connection.request);
  if (!reservation) {
    connection.close(true);
    return;
  }
  clearTimeout(reservation.timeout);
  reservations.delete(connection.request);
  connection.once("close", reservation.release);
  let start = Date.now(),
    count = 0;
  connection.on("packet", () => {
    const now = Date.now();
    if (now - start >= 10_000) {
      start = now;
      count = 0;
    }
    // Count every packet, including unknown events and commands without an ack.
    if (++count > 80 || !guard.take("packet", reservation.ip))
      connection.close(true);
  });
});
io.on("connection", (socket) => {
  const ip = identify(socket.request);
  let idleTimer: NodeJS.Timeout;
  const startIdleTimer = () => {
    clearTimeout(idleTimer);
    // Closing the transport lets Socket.IO reconnect automatically when needed;
    // a server namespace disconnect would leave an idle homepage unusable.
    idleTimer = setTimeout(() => socket.conn.close(), 60_000);
    idleTimer.unref();
  };
  startIdleTimer();
  let last = 0,
    windowStart = 0,
    count = 0;
  socket.on("command", (data: unknown, ack: (r: Reply) => void) => {
    if (typeof ack !== "function") return;
    try {
      const now = Date.now();
      if (now - windowStart > 10_000) {
        windowStart = now;
        count = 0;
      }
      if (++count > 80) throw Error("操作太频繁，请稍后再试。");
      if (!data || typeof data !== "object") throw Error("无效请求。");
      const d = data as Record<string, unknown>;
      if (d.type === "create" || d.type === "join") {
        try {
          rooms.find(socket.id);
          throw Error("请先离开当前房间。");
        } catch (e) {
          if ((e as Error).message !== "请先加入房间。") throw e;
        }
        if (d.type === "create" && now - last < 3000)
          throw Error("请稍后再创建房间。");
        if (typeof d.name !== "string" || d.name.length > 64)
          throw Error("请输入昵称。");
        if (d.type === "create") {
          if (!guard.take("create", ip))
            throw Error("创建房间太频繁，请稍后再试。");
          last = now;
          ack({ ok: true, ...rooms.create(socket.id, d.name) });
        } else {
          if (
            typeof d.room !== "string" ||
            d.room.length > 32 ||
            (d.token !== undefined &&
              (typeof d.token !== "string" || d.token.length > 64))
          )
            throw Error("无效房间链接。");
          ack({
            ok: true,
            ...rooms.join(
              d.room,
              socket.id,
              d.name,
              d.token as string | undefined,
            ),
          });
        }
        clearTimeout(idleTimer);
        return;
      }
      if (d.type === "leave") {
        rooms.leave(socket.id);
        startIdleTimer();
        ack({ ok: true });
        return;
      }
      if (
        d.type !== "action" ||
        !Number.isSafeInteger(d.revision) ||
        !d.action ||
        typeof d.action !== "object"
      )
        throw Error("无效操作。");
      const a = d.action as Record<string, unknown>;
      if (
        ![
          "play",
          "draw",
          "challenge",
          "uno",
          "catch",
          "roulette",
          "pause",
          "resume",
          "rematch",
        ].includes(String(a.type))
      )
        throw Error("无效操作。");
      if (
        a.type === "play" &&
        (typeof a.cardId !== "string" ||
          a.cardId.length > 64 ||
          (a.uno !== undefined && typeof a.uno !== "boolean"))
      )
        throw Error("无效牌。");
      rooms.update(socket.id, d.revision as number, a as Action);
      ack({ ok: true });
    } catch (e) {
      ack({ ok: false, error: e instanceof Error ? e.message : "请求失败。" });
    }
  });
  socket.on("disconnect", () => {
    clearTimeout(idleTimer);
    rooms.disconnect(socket.id);
  });
});
if (process.env.NODE_ENV === "production") {
  app.use(express.static(resolve("dist/client")));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(resolve("dist/client/index.html")),
  );
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
const port = Number(process.env.PORT ?? 3000);
http.listen(port, "0.0.0.0", () =>
  console.log(`UNO server listening on port ${port}`),
);
function shutdown() {
  io.close();
  http.close();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
