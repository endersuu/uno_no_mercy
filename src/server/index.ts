import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { resolve } from "node:path";
import { Rooms } from "./rooms.js";
import type { Action, Reply } from "../shared/types.js";
const app = express(),
  http = createServer(app),
  io = new Server(http, { maxHttpBufferSize: 8192 });
app.disable("x-powered-by");
app.get("/health", (_req, res) => res.json({ ok: true }));
const rooms = new Rooms((id, v) => io.to(id).emit("state", v));
setInterval(() => rooms.expire(), 500).unref();
io.on("connection", (socket) => {
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
          last = now;
          ack({ ok: true, ...rooms.create(socket.id, d.name) });
        } else {
          if (
            typeof d.room !== "string" ||
            d.room.length > 32 ||
            (d.token !== undefined && typeof d.token !== "string")
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
        return;
      }
      if (d.type === "leave") {
        rooms.leave(socket.id);
        ack({ ok: true });
        return;
      }
      if (
        d.type !== "action" ||
        typeof d.revision !== "number" ||
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
          (a.uno !== undefined && typeof a.uno !== "boolean"))
      )
        throw Error("无效牌。");
      rooms.update(socket.id, d.revision, a as Action);
      ack({ ok: true });
    } catch (e) {
      ack({ ok: false, error: e instanceof Error ? e.message : "请求失败。" });
    }
  });
  socket.on("disconnect", () => rooms.disconnect(socket.id));
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
