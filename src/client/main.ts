import { io } from "socket.io-client";
import {
  COLORS,
  colorNames,
  type Card,
  type View,
  type Reply,
  type Action,
} from "../shared/types";
import { rules, cardGuide } from "./rules";
import { gameAudio } from "./audio";
import { cardMarkup } from "./cards";
import "./style.css";
import "./feedback.css";
import "./viewport.css";
import { layoutHand } from "./hand-layout";
import {
  cancelMotion,
  describeEvent,
  settle,
  opening,
  transition,
  type Feedback,
} from "./motion";
declare const __APP_VERSION__: string;
declare const __BUILD_COMMIT__: string;
// Direct esbuild fixtures do not use Vite's build-time metadata.
const appVersion =
  typeof __APP_VERSION__ === "string" ? `v${__APP_VERSION__}` : "开发版";
const buildCommit =
  typeof __BUILD_COMMIT__ === "string" ? __BUILD_COMMIT__ : "local";
const app = document.querySelector<HTMLDivElement>("#app")!;
const announcement = document.createElement("div");
announcement.id = "game-announcement";
announcement.className = "sr-only";
announcement.setAttribute("role", "status");
announcement.setAttribute("aria-live", "polite");
document.body.append(announcement);
const socket = io({ autoConnect: false });
let state: View | null = null,
  busy = false,
  online = false,
  joining = false,
  uno = false;
let pending: Card | null = null;
let presenting = false;
let queue: { view: View; opening: boolean }[] = [];
let roundOpening = false;
let handPage = 0;
let handPageSize = 1;
let handRound: string | null = null;
let handObserver: ResizeObserver | null = null;
let restoringSeat = false;
let debugSelection: { room: string; roundId: string } | null = null;
let debugRequest: { room: string; roundId: string } | null = null;
interface Recovery {
  room: string;
  token: string;
  name: string;
  until: number;
  timer?: ReturnType<typeof setTimeout>;
}
let recovery: Recovery | null = null;
let stoppedRecoveryRoom: string | null = null;
function cancelRecovery() {
  if (recovery?.timer) clearTimeout(recovery.timer);
  recovery = null;
}
function retryRecovery(attempt: Recovery) {
  if (recovery !== attempt) return;
  if (attempt.timer) clearTimeout(attempt.timer);
  if (Date.now() >= attempt.until) {
    stoppedRecoveryRoom = attempt.room;
    cancelRecovery();
    applyImmediately(null);
    toast("未能恢复席位，请关闭同一房间的其他页面后重新加入。");
    return;
  }
  attempt.timer = setTimeout(() => {
    if (recovery !== attempt) return;
    if (
      roomFromUrl() !== attempt.room ||
      get(`uno-token-${attempt.room}`) !== attempt.token
    ) {
      cancelRecovery();
      render();
      return;
    }
    if (online && !joining) void enter("join", attempt.name, attempt.room);
    else retryRecovery(attempt);
  }, 1500);
}
let latest: View | null = null;
let generation = 0;
let motionAbort = new AbortController();
let resync = true;
let feedback: Feedback | null = null;
let freshCards = new Set<string>();
let pendingAction: Action | null = null;
let toastTimer: ReturnType<typeof setTimeout>;
function syncControls() {
  app.classList.toggle("is-pending", busy);
  app.dataset.animating = String(presenting);
  updateTurnUI();
  syncDebugControls();
  if (busy || presenting || recovery) {
    app
      .querySelectorAll<HTMLButtonElement>(
        ".hand button, .hand-actions button, .hand-navigation button, .play-controls button, #rematch, #entry button",
      )
      .forEach((el) => (el.disabled = true));
  }
  const status = app.querySelector(".table-status");
  if (status && busy && pendingAction)
    status.textContent =
      pendingAction.type === "play"
        ? "正在出牌，等待确认…"
        : pendingAction.type === "draw"
          ? "正在抽牌…"
          : pendingAction.type === "challenge"
            ? "正在核实 +4…"
            : "正在确认操作…";
  if (pendingAction?.type === "play")
    app
      .querySelector(`[data-card="${pendingAction.cardId}"]`)
      ?.classList.add("pending-card");
}
function announce(message: Feedback) {
  feedback = message;
  const box = app.querySelector<HTMLElement>(".action-receipt");
  if (box) {
    box.dataset.tone = message.tone;
    box.querySelector("b")!.textContent = message.title;
    box.querySelector("p")!.textContent = message.detail;
  }
  document.querySelector("#game-announcement")!.textContent =
    `${message.title}。${message.detail}`;
}
function applyImmediately(
  v: View | null,
  audio: "cancel" | "preserve" = "cancel",
) {
  generation++;
  motionAbort.abort();
  motionAbort = new AbortController();
  cancelMotion();
  if (audio === "cancel") gameAudio.cancelPending();
  roundOpening = false;
  queue = [];
  presenting = false;
  freshCards.clear();
  state = v;
  latest = v;
  if (v) feedback = v.phase === "waiting" ? null : describeEvent(v);
  else feedback = null;
  render();
}
async function presentQueue() {
  if (presenting) return;
  presenting = true;
  const run = generation;
  let lastPrevious: View | null = state;
  syncControls();
  try {
    while (queue.length && run === generation) {
      const item = queue.shift()!;
      const next = item.view;
      const previous = state;
      const isEvent =
        !!next.event &&
        previous?.phase === "playing" &&
        next.event.id !== previous.event?.id;
      if (item.opening) {
        roundOpening = true;
        state = next;
        feedback = {
          title: "新一局 · 正在翻开首张牌",
          detail: "首张牌只决定起始颜色，0 / 7 不触发换手。",
          tone: "normal",
        };
        render(true);
        gameAudio.play("deal");
        await opening(next, motionAbort.signal, {
          reveal: () => gameAudio.opening(),
        });
        if (run !== generation) return;
        roundOpening = false;
      }
      if (isEvent) {
        announce(describeEvent(next));
        gameAudio.event(next);
        await transition(previous!, next, motionAbort.signal, {
          effect: () => gameAudio.effect(next),
        });
        if (run !== generation) return;
      }
      freshCards = new Set(
        isEvent && (next.event!.drawn[next.me] > 0 || next.event!.swapped)
          ? next.hand
              .filter((c) => !previous!.hand.some((old) => old.id === c.id))
              .map((c) => c.id)
          : [],
      );
      lastPrevious = previous;
      state = next;
      if (
        !previous ||
        previous.phase === "waiting" ||
        (previous.phase === "finished" && next.phase === "playing")
      )
        feedback = describeEvent(next);
      render(true);
    }
  } catch {
    if (run === generation) applyImmediately(latest);
  } finally {
    if (run === generation) {
      presenting = false;
      render();
      if (state) {
        settle(lastPrevious, state);
        gameAudio.settled(lastPrevious, state);
      }
    }
  }
}
function receive(v: View) {
  latest = v;
  const freshOpening =
    v.phase === "playing" &&
    !v.event &&
    !restoringSeat &&
    v.pausedBy === null &&
    !v.disconnected &&
    !document.hidden &&
    (!state || state.roundId !== v.roundId || state.phase === "waiting");
  restoringSeat = false;
  if (v.phase !== "playing" || v.pausedBy !== null || v.disconnected)
    dialog("colors").close();
  if (
    ((resync || !state || v.room !== state.room) && !freshOpening) ||
    v.phase === "waiting" ||
    v.pausedBy !== null ||
    v.disconnected ||
    v.closed ||
    document.hidden
  ) {
    resync = false;
    applyImmediately(v);
    return;
  }
  resync = false;
  queue.push({ view: v, opening: freshOpening });
  if (queue.length > 4) {
    applyImmediately(v);
    return;
  }
  void presentQueue();
}
const roomFromUrl = () => new URL(location.href).searchParams.get("room");
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const dialog = (id: string) =>
  document.querySelector<HTMLDialogElement>(`#${id}`)!;
const get = (k: string) => {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
};
const set = (k: string, v: string) => {
  try {
    sessionStorage.setItem(k, v);
  } catch {
    toast("浏览器无法保存重连凭证，请不要刷新页面。");
  }
};
function toast(message: string) {
  const el = document.querySelector<HTMLElement>("#toast")!;
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 4500);
}
async function command(data: object, recovering = false): Promise<Reply> {
  if (!socket.connected) {
    toast("连接已断开，正在重连…");
    return { ok: false, error: "offline" };
  }
  busy = true;
  syncControls();
  try {
    const r = (await socket
      .timeout(6000)
      .emitWithAck("command", data)) as Reply;
    if (!r.ok && !(recovering && r.error === "这个席位已在另一个页面连接。"))
      toast(r.error);
    return r;
  } catch {
    toast("请求未确认，正在同步房间状态…");
    socket.disconnect().connect();
    return { ok: false, error: "timeout" };
  } finally {
    busy = false;
    render();
  }
}
async function action(a: Action | { type: "pause" | "resume" | "rematch" }) {
  if (
    !state ||
    busy ||
    recovery ||
    (presenting && !["pause", "resume"].includes(a.type))
  )
    return false;
  if (!["pause", "resume", "rematch"].includes(a.type))
    pendingAction = a as Action;
  const r = await command({
    type: "action",
    revision: ["pause", "resume"].includes(a.type)
      ? (latest?.revision ?? state.revision)
      : state.revision,
    action: a,
  });
  pendingAction = null;
  if (!r.ok) render();
  return r.ok;
}
function syncDebugControls() {
  const exporting = !!debugRequest && debugRequest.room === state?.room;
  const button = app.querySelector<HTMLButtonElement>("#export-debug");
  const select = app.querySelector<HTMLSelectElement>("#debug-round");
  if (button) {
    button.disabled = !online || exporting || !select?.value;
    button.textContent = exporting ? "正在导出…" : "导出对局记录（JSON）";
    button.setAttribute("aria-busy", String(exporting));
  }
  if (select) select.disabled = exporting;
}
async function exportDebug() {
  const roundId = app.querySelector<HTMLSelectElement>("#debug-round")?.value;
  if (!state || !roundId || debugRequest) return;
  if (!socket.connected) {
    toast("连接已断开，重连后可导出对局记录。");
    return;
  }
  const request = { room: state.room, roundId };
  debugRequest = request;
  syncDebugControls();
  try {
    const reply = (await socket.timeout(20_000).emitWithAck("command", {
      type: "debug-export",
      roundId,
    })) as Reply;
    if (debugRequest !== request || state?.room !== request.room) return;
    if (!reply.ok) {
      toast(reply.error);
      return;
    }
    const snapshot = reply.snapshot;
    if (
      !snapshot ||
      snapshot.room !== request.room ||
      snapshot.round.roundId !== request.roundId
    ) {
      toast("未收到这一局的记录，请重试。");
      return;
    }
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(snapshot, null, 2)], {
        type: "application/json;charset=utf-8",
      }),
    );
    const link = document.createElement("a");
    const safeId = snapshot.round.roundId.replace(/[^a-zA-Z0-9_-]/g, "_");
    link.href = url;
    link.download = `uno-round-${snapshot.round.round}-${safeId}.json`;
    link.hidden = true;
    document.body.append(link);
    try {
      link.click();
    } finally {
      // Safari may consume the Blob URL after the click handler has finished.
      setTimeout(() => {
        link.remove();
        URL.revokeObjectURL(url);
      }, 60_000);
    }
    toast(
      snapshot.complete
        ? "对局记录已导出，可将 JSON 文件用于排查。"
        : "记录已导出，但部分记录缺失，文件中附有原因。",
    );
  } catch {
    if (debugRequest === request && state?.room === request.room)
      toast("导出未完成，请检查连接后重试。");
  } finally {
    if (debugRequest === request) {
      debugRequest = null;
      syncDebugControls();
    }
  }
}
function card(c: Card, button = false, enabled = false) {
  return cardMarkup(c, button, enabled, freshCards.has(c.id));
}
function turnInfo(v: View) {
  if (recovery)
    return {
      mode: "paused",
      title: "正在恢复连接…",
      hint: "等待旧连接断开，正在自动恢复原来的席位。",
      icon: "Ⅱ",
    };
  if (v.phase === "finished")
    return {
      mode: "finished",
      title: "本局已结束",
      hint: "看看本局结果，双方准备后可以再来一局。",
      icon: "✓",
    };
  if (!online || v.disconnected || v.pausedBy !== null)
    return {
      mode: "paused",
      title: "对局已暂停",
      hint: v.disconnected ? "等待断线玩家重连。" : "恢复游戏后才能出牌。",
      icon: "Ⅱ",
    };
  if (busy || presenting)
    return {
      mode: "resolving",
      title: roundOpening
        ? "正在翻开第一张牌…"
        : busy
          ? "正在确认操作…"
          : "正在结算这一手…",
      hint: "请稍候，结算完成后会亮起可用操作。",
      icon: "⋯",
    };
  if (v.turn !== v.me)
    return {
      mode: "opponent",
      title: "对方回合 · 请等待",
      hint: `${v.players[1 - v.me].name}正在出牌，你的出牌操作暂不可用。`,
      icon: "◷",
    };
  return {
    mode: "mine",
    title: "轮到你出牌",
    hint: v.roulette
      ? "请选择颜色，开始颜色轮盘。"
      : v.penalty
        ? `需要处理 +${v.penalty}：可以叠加${v.challenge ? "、质疑" : ""}，或接受罚抽。`
        : v.playable.length
          ? `你有 ${v.playable.length} 张牌可以出，点击亮起的牌。`
          : "没有可出的牌，请点击亮起的「抽到可出的牌」。",
    icon: "➜",
  };
}
function updateTurnUI() {
  if (!state) return;
  const info = turnInfo(state),
    game = app.querySelector<HTMLElement>(".game");
  if (game) game.dataset.turn = info.mode;
  const banner = app.querySelector(".turn-banner");
  if (banner) {
    banner.querySelector("b")!.textContent = info.title;
    banner.querySelector("p")!.textContent = info.hint;
    banner.querySelector(".turn-icon")!.textContent = info.icon;
  }
  const tag = app.querySelector(".hand-turn-tag");
  if (tag)
    tag.textContent =
      info.mode === "mine"
        ? "轮到你"
        : info.mode === "opponent"
          ? "对方回合"
          : info.mode === "paused"
            ? "已暂停"
            : info.mode === "finished"
              ? "本局结束"
              : "正在结算";
}
function soundLabel() {
  return !gameAudio.enabled
    ? "♪ 音效 关"
    : gameAudio.ready
      ? "♪ 音效 开"
      : "♪ 点此启用声音";
}
function updateSoundButton() {
  const b = document.querySelector<HTMLButtonElement>("#toggle-sound");
  if (b) {
    b.textContent = soundLabel();
    b.setAttribute("aria-pressed", String(gameAudio.enabled));
    b.title = gameAudio.enabled
      ? gameAudio.ready
        ? "音效已就绪；点击静音"
        : "点击页面启用声音；也可在游戏规则中试听"
      : "点击开启音效";
  }
}

function header() {
  return `<header><a href="/" class="brand" id="brand"><span class="brand-mark">U<span>!</span></span><span class="brand-title">UNO<small>NO MERCY</small></span><span class="app-version" id="app-version" title="当前版本 ${esc(appVersion)} · ${esc(buildCommit)}" aria-label="当前版本 ${esc(appVersion)}，发布标识 ${esc(buildCommit)}"><span>${esc(appVersion)}</span><span>${esc(buildCommit)}</span></span></a><div class="header-actions"><span class="connection"><i class="${online ? "" : "off"}"></i>${online ? "已连接" : "连接中"}</span><button class="ghost compact sound-toggle" id="toggle-sound" aria-label="切换游戏音效" aria-pressed="${gameAudio.enabled}">${soundLabel()}</button><button class="ghost compact" id="open-rules">游戏规则 ↗</button>${state ? '<button class="ghost compact" id="leave-room">离开房间</button>' : ""}</div></header>`;
}
function home() {
  const room = roomFromUrl();
  return `<main class="landing"><section class="intro"><span class="eyebrow"><i></i> TWO PLAYERS. ZERO MERCY.</span><h1>朋友局。<br><span>不留情。</span></h1><p class="intro-copy">一条链接，一位朋友。<br>把好运留在手里，把 +10 送给对方。</p><div class="hero-cards" aria-hidden="true">${card({ id: "a", kind: "number", color: "green", value: 7 })}${card({ id: "b", kind: "wild10", color: null })}${card({ id: "c", kind: "draw4", color: "red" })}</div><div class="pills"><span>2 人实时对战</span><span>无需登录</span><span>168 张 · No Mercy</span></div></section><section class="entry-panel"><span class="eyebrow">${room ? "YOU’RE INVITED" : "THE TABLE IS YOURS"}</span><h2>${room ? "有位朋友，在等你。" : "开一桌，叫上朋友。"}</h2><p class="muted" ${recovery ? 'id="reconnect-status" role="status"' : ""}>${recovery ? "正在恢复原来的席位…等待旧连接断开，会自动重试。若同一房间还有其他页面，请先关闭。" : room ? "输入昵称，加入这场不留情的对决。" : "创建专属房间，把邀请链接发给 TA。"}</p><form id="entry"><label for="name">你的昵称 <span>可选</span></label><input id="name" name="name" maxlength="16" placeholder="今天怎么称呼你？" value="${esc(get("uno-name") ?? "")}" autocomplete="nickname"><button class="primary wide" type="submit" ${!online || busy || recovery ? "disabled" : ""}>${recovery ? "正在恢复席位…" : busy ? "正在进入…" : room ? "加入房间 →" : "创建房间 →"}</button></form><div class="entry-divider"></div><div class="entry-detail"><span>01</span><div><b>只有你们两个人</b><p>私密房间，分享链接即可入座</p></div></div><div class="entry-detail"><span>02</span><div><b>再来一局？双方说了算</b><p>不记分，不排名，只管享受对局</p></div></div>${room ? '<button class="text-button" id="new-room">创建自己的房间 ↗</button>' : '<p class="small-note">准备好接下那张 +10 了吗？</p>'}</section></main><section class="quick-rules"><div><span>01 / STACK IT</span><h3>罚抽，可以加倍。</h3><p>+2 → +4 → +6，谁接不住谁抽。</p></div><div><span>02 / SWITCH IT</span><h3>一张 7，局势反转。</h3><p>交换全部手牌，好牌也留不住。</p></div><div><span>03 / NO MERCY</span><h3>25 张，就此出局。</h3><p>别让手里的牌变成一座山。</p></div></section>`;
}
function waiting(v: View) {
  return `<main class="waiting"><span class="eyebrow">ROOM / ${esc(v.room)}</span><h1>座位留好了。<br><span>就差你的朋友。</span></h1><p class="muted">${v.disconnected ? "对方暂时离线，保留席位等待重连。" : "对方打开链接加入后，游戏自动开始。"}</p>${v.disconnected ? '<p id="countdown" class="muted"></p>' : ""}<div class="waiting-seats"><div><span class="avatar">${esc(v.players[v.me].name[0])}</span><b>${esc(v.players[v.me].name)} <small>你</small></b><span class="ready-tag">已入座</span></div><span class="versus">VS</span><div><span class="avatar empty">＋</span><b>虚位以待</b><span class="muted">等一位够胆的朋友</span></div></div><div class="invite"><input aria-label="邀请链接" readonly value="${esc(location.href)}"><button class="primary" id="copy-link">复制邀请链接 ↗</button></div><p class="small-note">断线席位保留 60 秒 · 空房间自动销毁</p></main>`;
}
function debugControls(v: View) {
  const rounds = v.debugRounds ?? [];
  if (!rounds.length) return "";
  const selected =
    debugSelection?.room === v.room &&
    rounds.some((r) => r.roundId === debugSelection?.roundId)
      ? debugSelection.roundId
      : (v.roundId ?? rounds.at(-1)!.roundId);
  return `<section class="debug-export" aria-label="对局调试记录"><div class="debug-export-controls"><label for="debug-round">对局记录</label><select id="debug-round">${rounds
    .map(
      (r) =>
        `<option value="${esc(r.roundId)}" ${r.roundId === selected ? "selected" : ""}>第 ${r.round} 局 · ${r.finishedAt ? "已结束" : "进行中"}${r.complete ? "" : " · 记录不完整"}</option>`,
    )
    .join(
      "",
    )}</select><button class="ghost" id="export-debug" type="button" aria-describedby="debug-export-note" ${!online || debugRequest?.room === v.room ? "disabled" : ""}>${debugRequest?.room === v.room ? "正在导出…" : "导出对局记录（JSON）"}</button></div><p id="debug-export-note">点击导出双方手牌、牌堆和完整操作记录。请在离开房间前保存；服务器重启后记录会清除。</p></section>`;
}
function table(v: View) {
  const me = v.players[v.me],
    other = v.players[1 - v.me],
    myTurn = v.turn === v.me,
    paused = v.pausedBy !== null || v.disconnected || !online,
    ended = v.phase === "finished",
    canAct = !paused && !ended && !busy && !presenting && !recovery,
    showChallenge = myTurn && v.challenge && !ended;
  return `<main class="game" data-opening="${roundOpening}" data-turn="${turnInfo(v).mode}"><div class="game-heading"><div><span class="eyebrow">THE FRIENDLY SHOWDOWN</span><h2>这一局，不留情。</h2></div><button class="ghost" id="pause" ${ended ? "disabled" : ""}>Ⅱ 暂停 / 看规则</button></div><section class="turn-banner" role="status" aria-live="polite"><span class="turn-icon">${turnInfo(v).icon}</span><div><b>${esc(turnInfo(v).title)}</b><p>${esc(turnInfo(v).hint)}</p></div></section><section class="table"><div class="opponent"><span class="avatar">${esc(other.name[0] ?? "?")}</span><div><b>${esc(other.name)}</b><span>${other.connected ? "在线" : "离线"} · ${other.count} 张手牌</span></div><div class="back-cards" aria-hidden="true">${Array.from({ length: Math.min(other.count, 7) }, () => "<i>U!</i>").join("")}</div><span class="turn-pill ${!myTurn && !ended ? "current" : ""}">${!myTurn && !ended ? "TA 的回合" : "对手"}</span></div><div class="table-center"><div class="draw-pile" aria-hidden="true"><span>UNO</span><small>NO MERCY</small></div><div class="discard">${v.top ? card(v.top) : ""}</div><div class="table-info"><span class="eyebrow">CURRENT COLOR</span><b class="color-indicator ${v.color}">${v.color ? colorNames[v.color] : ""}</b><span>${v.penalty ? `累计罚抽 <strong>+${v.penalty}</strong>` : "匹配颜色、数字或图案"}</span></div></div><div class="action-receipt" data-tone="${feedback?.tone ?? "normal"}"><span>刚刚发生</span><b>${esc(feedback?.title ?? "手牌已发好")}</b><p>${esc(feedback?.detail ?? "每人 7 张，准备开始。")}</p></div><div class="table-status ${myTurn && !paused && !ended ? "your-turn" : ""}" aria-live="polite">${ended ? "本局结束" : paused ? "Ⅱ 对局已暂停" : presenting ? "正在展示本次操作…" : myTurn ? "轮到你了，出一张好牌。" : "等待对手出牌…"}</div></section><div class="round-notice">${paused && !ended ? `<section class="pause-banner"><div><b>${!online ? "网络已断开，正在尝试重连" : v.disconnected ? "对手断线，对局已暂停" : "规则时间，慢慢看。"}</b><p>${v.disconnected ? `<span id="countdown"></span> · 原标签页可重连` : v.pausedBy === v.me ? "你发起了暂停，准备好后继续。" : "对手正在查看规则，请等待对方继续。"}</p></div>${v.pausedBy === v.me ? `<button class="primary" id="resume" ${!online || busy ? "disabled" : ""}>继续游戏 →</button>` : ""}</section>` : ""}${ended ? `<section class="result"><div><span class="eyebrow">THAT’S A WRAP</span><h2>${v.winner === v.me ? "这局，你赢了！" : "这局，让 TA 赢了。"}</h2><p>${esc(v.reason)}</p></div><div>${v.closed ? '<button class="primary" id="back-home">回到首页 →</button>' : `<button class="primary" id="rematch" ${me.rematch || busy || !online ? "disabled" : ""}>${me.rematch ? "已准备，等待对手…" : "再来一局 ↗"}</button><p class="small-note">${other.rematch ? "对方已准备好" : "双方同意后重新发牌"}</p>`}</div></section>` : ""}</div><section class="hand-section"><div class="hand-heading"><div><h3>你的手牌 <span>${me.count}</span><strong class="hand-turn-tag"></strong></h3><p>${!canAct ? "" : myTurn ? (v.roulette ? "选择轮盘颜色，然后抽到该颜色为止。" : v.penalty ? `叠加 +${v.lastPenalty} 或更大的罚抽牌，或接受罚抽。` : "亮起的牌可以打出。") : "想好下一张，轮到你就出。"}</p></div><div class="hand-actions">${canAct && v.canCatch ? '<button class="danger" id="catch">抓漏喊 UNO</button>' : ""}<button class="uno-button" id="uno" ${!canAct || me.count !== 1 ? "disabled" : ""}>UNO!</button></div><nav class="hand-navigation" aria-label="手牌翻页"><button class="ghost compact" id="hand-prev" aria-label="上一组手牌">‹</button><span class="hand-page-label" role="status" aria-live="polite"></span><button class="ghost compact" id="hand-next" aria-label="下一组手牌">›</button><button class="ghost compact" id="hand-playable" hidden>查看可出牌</button></nav></div><div class="hand" role="group" aria-label="你的手牌"></div><div class="play-controls"><label class="check-label"><input id="auto-uno" type="checkbox" ${uno ? "checked" : ""}> 出牌时喊 UNO</label><div class="button-row">${showChallenge ? `<button class="ghost penalty-action" id="challenge" ${!canAct ? "disabled" : ""}><strong class="penalty-label">质疑</strong><span class="penalty-outcome">成功：对方抽 ${v.penalty} 张</span><span class="penalty-outcome">失败：你抽 ${v.penalty + 2} 张</span></button>` : ""}${myTurn && v.roulette ? `<button class="primary" id="roulette" ${!canAct ? "disabled" : ""}>选择轮盘颜色 →</button>` : `<button class="primary${v.penalty ? " penalty-action" : ""}" id="draw" ${!canAct || !myTurn || (!v.penalty && v.playable.length > 0) ? "disabled" : ""}>${v.penalty ? `<strong class="penalty-label">接受</strong><span class="penalty-outcome">你抽 ${v.penalty} 张</span>` : "抽到可出的牌 ↓"}</button>`}</div></div></section><details class="activity"><summary>本局动态 <span>${esc(v.log.at(-1) ?? "")}</span></summary>${debugControls(v)}<ol>${v.log
    .slice()
    .reverse()
    .map((l) => `<li>${esc(l)}</li>`)
    .join("")}</ol></details></main>`;
}
function on(id: string, event: string, fn: (e: Event) => void) {
  document.getElementById(id)?.addEventListener(event, fn);
}
function render(force = false) {
  if (presenting && !force) {
    syncControls();
    return;
  }
  if (debugRequest && debugRequest.room !== state?.room) debugRequest = null;
  if (debugSelection && debugSelection.room !== state?.room)
    debugSelection = null;
  handObserver?.disconnect();
  const handScrollTop = app.querySelector<HTMLElement>(".hand")?.scrollTop ?? 0;
  const gameScreen = !!state && state.phase !== "waiting";
  document.body.classList.toggle("game-screen", gameScreen);
  const activityOpen =
    !!app.querySelector<HTMLDetailsElement>(".activity")?.open;
  const focused = document.activeElement as HTMLElement | null;
  const focusedId = focused?.id;
  const focusedCard = focused?.dataset.card;
  app.dataset.revision = String(state?.revision ?? 0);
  const input = document.querySelector<HTMLInputElement>("#name");
  const draft = input?.value;
  const focus = input === document.activeElement;
  app.innerHTML =
    header() +
    (state
      ? state.phase === "waiting"
        ? waiting(state)
        : table(state)
      : home()) +
    "<footer><span>UNO / NO MERCY</span><span>一场朋友间的较量。<small>非官方同人游戏 · 无需账号</small></span><span>MADE FOR TWO ↗</span></footer>";
  if (draft !== undefined) {
    const el = document.querySelector<HTMLInputElement>("#name");
    if (el) {
      el.value = draft;
      if (focus) el.focus();
    }
  }
  on("brand", "click", (e) => {
    if (state) {
      e.preventDefault();
      dialog("leave").showModal();
    }
  });
  on("toggle-sound", "click", () => {
    if (gameAudio.enabled && !gameAudio.ready) {
      void gameAudio.preview().then(updateSoundButton);
      return;
    }
    gameAudio.setEnabled(!gameAudio.enabled);
    updateSoundButton();
    if (gameAudio.enabled) void gameAudio.preview().then(updateSoundButton);
  });
  on("open-rules", "click", () => openRules());
  on("pause", "click", () => openRules());
  on("leave-room", "click", () => dialog("leave").showModal());
  on("resume", "click", () => action({ type: "resume" }));
  on("rematch", "click", () => action({ type: "rematch" }));
  on("draw", "click", () => action({ type: "draw" }));
  on("challenge", "click", () => action({ type: "challenge" }));
  on("debug-round", "change", (e) => {
    if (state)
      debugSelection = {
        room: state.room,
        roundId: (e.target as HTMLSelectElement).value,
      };
  });
  on("export-debug", "click", () => void exportDebug());
  on("uno", "click", () => action({ type: "uno" }));
  on("catch", "click", () => action({ type: "catch" }));
  on("auto-uno", "change", (e) => {
    uno = (e.target as HTMLInputElement).checked;
  });
  on("roulette", "click", () => chooseColor(null));
  on("copy-link", "click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast("邀请链接已复制，发给朋友吧。");
    } catch {
      document.querySelector<HTMLInputElement>(".invite input")?.select();
      toast("请复制选中的邀请链接。");
    }
  });
  on("new-room", "click", () => {
    if (busy || joining) return;
    cancelRecovery();
    history.replaceState(null, "", "/");
    render();
  });
  on("back-home", "click", () => leaveRoom());
  on("entry", "submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    const name =
      document.querySelector<HTMLInputElement>("#name")!.value.trim() ||
      "匿名玩家";
    set("uno-name", name);
    const room = roomFromUrl();
    await enter(room ? "join" : "create", name, room);
  });
  if (gameScreen && state) {
    const sameHand = handRound === state.roundId;
    if (handRound !== state.roundId) {
      handPage = 0;
      handRound = state.roundId;
    }
    renderHand();
    on("hand-prev", "click", () => changeHandPage(handPage - 1));
    on("hand-next", "click", () => changeHandPage(handPage + 1));
    const hand = app.querySelector<HTMLElement>(".hand")!;
    if (sameHand) hand.scrollTop = handScrollTop;
    let lastWidth = hand.clientWidth;
    let lastHeight = hand.clientHeight;
    handObserver = new ResizeObserver(() => {
      // The initial observer delivery must not replace cards whose entrance
      // animation has just started. Only a real size change needs new paging.
      if (hand.clientWidth !== lastWidth || hand.clientHeight !== lastHeight) {
        lastWidth = hand.clientWidth;
        lastHeight = hand.clientHeight;
        if (!presenting) renderHand();
      }
    });
    handObserver.observe(hand);
  }
  const activity = app.querySelector<HTMLDetailsElement>(".activity");
  if (activity) activity.open = activityOpen;
  if (!focus && focusedId)
    document.getElementById(focusedId)?.focus({ preventScroll: true });
  else if (focusedCard)
    app
      .querySelector<HTMLElement>(`[data-card="${focusedCard}"]`)
      ?.focus({ preventScroll: true });
  syncControls();
  countdown();
}
function changeHandPage(page: number) {
  if (busy || presenting) return;
  handPage = page;
  renderHand();
}
function renderHand() {
  const hand = app.querySelector<HTMLElement>(".hand");
  if (!hand || !state) return;
  const v = state;
  const scrollTop = hand.scrollTop;
  const focusedCard = (document.activeElement as HTMLElement | null)?.dataset
    .card;
  const previousFirst = handPage * handPageSize;
  const layout = layoutHand(hand, v.hand.length);
  app.querySelector<HTMLElement>(".hand-navigation")!.hidden =
    !layout.paginated;
  if (layout.pageSize !== handPageSize)
    handPage = Math.floor(previousFirst / layout.pageSize);
  handPageSize = layout.pageSize;
  const pages = Math.max(1, Math.ceil(v.hand.length / handPageSize));
  handPage = Math.max(0, Math.min(pages - 1, handPage));
  const start = handPage * handPageSize;
  const visible = v.hand.slice(start, start + handPageSize);
  const canAct =
    online &&
    !v.disconnected &&
    v.pausedBy === null &&
    v.phase === "playing" &&
    !busy &&
    !presenting &&
    !recovery;
  hand.innerHTML = visible
    .map((c) => card(c, true, canAct && v.playable.includes(c.id)))
    .join("");
  hand.scrollTop = layout.paginated ? 0 : scrollTop;
  const label = app.querySelector<HTMLElement>(".hand-page-label")!;
  label.textContent = v.hand.length
    ? `${start + 1}–${start + visible.length} / ${v.hand.length} 张`
    : "0 张";
  label.setAttribute("aria-label", `第 ${handPage + 1} 组，共 ${pages} 组手牌`);
  const previous = app.querySelector<HTMLButtonElement>("#hand-prev")!;
  const next = app.querySelector<HTMLButtonElement>("#hand-next")!;
  previous.disabled = busy || presenting || handPage === 0;
  next.disabled = busy || presenting || handPage === pages - 1;
  const jump = app.querySelector<HTMLButtonElement>("#hand-playable")!;
  const elsewhere = v.playable.filter(
    (id) => !visible.some((c) => c.id === id),
  ).length;
  jump.hidden = !elsewhere || v.turn !== v.me || v.phase !== "playing";
  jump.disabled = !canAct;
  jump.textContent = `另有 ${elsewhere} 张可出 →`;
  // Choose a different group even if the current one already has playable cards.
  jump.onclick = () => {
    const index = v.hand.findIndex(
      (c) =>
        v.playable.includes(c.id) &&
        !visible.some((shown) => shown.id === c.id),
    );
    if (index >= 0) changeHandPage(Math.floor(index / handPageSize));
  };
  hand.querySelectorAll<HTMLButtonElement>("[data-card]").forEach((el) =>
    el.addEventListener("click", async () => {
      const c = state?.hand.find((c) => c.id === el.dataset.card);
      if (!c) return;
      if (!c.color && c.kind !== "roulette") {
        chooseColor(c);
        return;
      }
      if (await action({ type: "play", cardId: c.id, uno })) {
        uno = false;
        render();
      }
    }),
  );
  if (focusedCard)
    hand
      .querySelector<HTMLElement>(`[data-card="${focusedCard}"]`)
      ?.focus({ preventScroll: true });
}
async function enter(
  type: "join" | "create",
  name: string,
  room: string | null,
) {
  if (joining) return;
  stoppedRecoveryRoom = null;
  const token = room ? get(`uno-token-${room}`) : null;
  if (type === "join" && room && token) {
    if (recovery?.room !== room || recovery.token !== token) {
      cancelRecovery();
      recovery = { room, token, name, until: Date.now() + 55_000 };
    }
    if (Date.now() >= recovery.until) {
      retryRecovery(recovery);
      return;
    }
  } else cancelRecovery();
  const attempt = recovery;
  joining = true;
  restoringSeat = !!token;
  try {
    const r = await command(
      {
        type,
        name,
        ...(room ? { room } : {}),
        ...(token ? { token } : {}),
      },
      !!attempt,
    );
    if (attempt && recovery !== attempt) return;
    if (r.ok && r.room && r.token) {
      cancelRecovery();
      set(`uno-token-${r.room}`, r.token);
      history.replaceState(null, "", `/?room=${encodeURIComponent(r.room)}`);
    } else if (!r.ok) {
      const retry =
        attempt &&
        ["这个席位已在另一个页面连接。", "offline", "timeout"].includes(
          r.error,
        );
      if (!retry) {
        if (attempt) stoppedRecoveryRoom = attempt.room;
        cancelRecovery();
      }
      applyImmediately(null);
      if (retry) retryRecovery(attempt);
    }
  } finally {
    joining = false;
    render();
  }
}
async function openRules() {
  if (online && state?.phase === "playing" && state.pausedBy === null) {
    if (!(await action({ type: "pause" }))) return;
  }
  if (!dialog("rules").open) dialog("rules").showModal();
}
function chooseColor(c: Card | null) {
  pending = c;
  document.querySelector("#color-title")!.textContent = c
    ? "选择接下来的颜色"
    : "选择颜色轮盘的颜色";
  dialog("colors").showModal();
}
async function leaveRoom() {
  if (busy) return;
  cancelRecovery();
  const r = await command({ type: "leave" });
  if (!r.ok) return;
  if (state) sessionStorage.removeItem(`uno-token-${state.room}`);
  applyImmediately(null);
  history.replaceState(null, "", "/");
  dialog("leave").close();
  render();
}
function countdown() {
  const el = document.querySelector("#countdown");
  if (!el || !state) return;
  const deadlines = state.players
    .map((p) => p.deadline)
    .filter((d): d is number => d !== null);
  el.textContent = deadlines.length
    ? `等待重连 ${Math.max(0, Math.ceil((Math.min(...deadlines) - Date.now()) / 1000))} 秒`
    : "等待连接恢复";
}
setInterval(countdown, 500);
document.querySelector("#rules-content")!.innerHTML = `
  <div class="rules-tabs" role="tablist" aria-label="规则说明分类">
    <button id="cards-tab" role="tab" aria-selected="true" aria-controls="cards-panel">每张牌的意思</button>
    <button id="match-tab" role="tab" aria-selected="false" aria-controls="match-panel" tabindex="-1">对局规则</button>
  </div>
  <div id="cards-panel" role="tabpanel" aria-labelledby="cards-tab" tabindex="0">
    <p class="guide-intro">对照牌面找作用：彩色牌展示一种颜色作为例子，同种牌的其他颜色效果相同。0 和 7 有特殊效果，单独列出。</p>
    <div class="card-guide-list">${cardGuide.map((entry) => `<article class="card-guide-entry">${cardMarkup(entry.example)}<div><h3>${entry.title}</h3><p>${entry.effect}</p><p class="card-guide-note">${entry.note}</p></div></article>`).join("")}</div>
    <aside class="guide-reminders"><h3>所有牌都要记住</h3><p>有待处理罚抽时，只能叠加不低于上一张罚抽数值的牌，或接受罚抽；+4 还可以质疑。初始翻牌只用数字牌，不触发 0 / 7 的效果。打出最后一张牌立即获胜，不再结算牌面效果。</p><p>+4 质疑成功：出牌者承担全部累计罚抽，质疑者抽 0 张、继续回合，整笔罚抽清零。质疑失败：质疑者抽累计罚抽量 +2 张，并跳过回合。例如累计 +12：成功时对手抽 12 张、你抽 0 张；失败时你抽 14 张。完整说明请切换到「对局规则」。</p></aside>
  </div>
  <div id="match-panel" role="tabpanel" aria-labelledby="match-tab" tabindex="0" hidden>${rules.map(([title, body]) => `<section><h3>${title}</h3><p>${body}</p></section>`).join("")}</div>`;
const ruleTabs = ["cards", "match"] as const;
function selectRulesTab(selected: (typeof ruleTabs)[number], focus = false) {
  for (const name of ruleTabs) {
    const tab = document.getElementById(`${name}-tab`)!;
    tab.setAttribute("aria-selected", String(name === selected));
    tab.tabIndex = name === selected ? 0 : -1;
    document.getElementById(`${name}-panel`)!.hidden = name !== selected;
    if (name === selected && focus) tab.focus();
  }
}
for (const name of ruleTabs) {
  on(`${name}-tab`, "click", () => selectRulesTab(name));
  on(`${name}-tab`, "keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
    event.preventDefault();
    selectRulesTab(
      key === "Home"
        ? "cards"
        : key === "End"
          ? "match"
          : name === "cards"
            ? "match"
            : "cards",
      true,
    );
  });
}
on("preview-sound", "click", async () => {
  gameAudio.setEnabled(true);
  await gameAudio.preview();
  updateSoundButton();
  toast(
    gameAudio.ready
      ? "已播放试听音效"
      : "浏览器暂未启用声音，请检查标签页静音或系统音量。",
  );
});
on("close-rules", "click", () => dialog("rules").close());
on("rules-done", "click", () => dialog("rules").close());
on("cancel-color", "click", () => dialog("colors").close());
on("stay", "click", () => dialog("leave").close());
on("confirm-leave", "click", () => leaveRoom());
document.querySelector("#color-options")!.innerHTML = COLORS.map(
  (c) => `<button class="${c}" data-color="${c}">${colorNames[c]}</button>`,
).join("");
document.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((b) =>
  b.addEventListener("click", async () => {
    const color = b.dataset.color as (typeof COLORS)[number];
    dialog("colors").close();
    if (pending) {
      if (await action({ type: "play", cardId: pending.id, color, uno })) {
        uno = false;
        render();
      }
    } else await action({ type: "roulette", color });
  }),
);
socket.on("connect", () => {
  resync = true;
  online = true;
  render();
  const room = roomFromUrl();
  if (room && room !== stoppedRecoveryRoom && get(`uno-token-${room}`))
    void enter("join", get("uno-name") ?? "匿名玩家", room);
});
socket.on("disconnect", () => {
  online = false;
  resync = true;
  applyImmediately(latest);
});
socket.on("state", receive);
document.addEventListener("visibilitychange", () => {
  if (document.hidden && latest) applyImmediately(latest);
  if (!document.hidden) updateSoundButton();
});
let viewportFrame = 0;
let viewportWidth = window.innerWidth;
let viewportHeight = 0;
function syncViewport() {
  const visual = window.visualViewport;
  // Preserve pinch zoom. On Safari, the visible height also follows the address
  // bar and keyboard, which can be smaller than the layout viewport.
  if (visual && Math.abs(visual.scale - 1) > 0.01) return;
  const height = Math.floor(visual?.height ?? window.innerHeight);
  const width = window.innerWidth;
  const changed = height !== viewportHeight || width !== viewportWidth;
  viewportHeight = height;
  viewportWidth = width;
  document.documentElement.style.setProperty(
    "--game-viewport-height",
    `${height}px`,
  );
  if (!changed) return;
  // A keyboard/address-bar resize invalidates animation coordinates, not the
  // accepted game event. Let its scheduled deal/landing sound finish normally.
  if (presenting && latest) applyImmediately(latest, "preserve");
  else renderHand();
}
function queueViewportSync() {
  cancelAnimationFrame(viewportFrame);
  viewportFrame = requestAnimationFrame(syncViewport);
}
window.addEventListener("resize", queueViewportSync);
window.visualViewport?.addEventListener("resize", queueViewportSync);
syncViewport();

function unlockSound(event: Event) {
  // These controls own activation: a capture listener must not turn "enable"
  // into "mute" by changing ready before their click handler runs.
  if (
    event.target instanceof Element &&
    event.target.closest("#toggle-sound, #preview-sound")
  )
    return;
  void gameAudio.unlock(true).then(updateSoundButton);
}
document.addEventListener(
  "pointerdown",
  (event) => {
    if (event.pointerType === "mouse") unlockSound(event);
  },
  { capture: true },
);
document.addEventListener(
  "pointerup",
  (event) => {
    if (event.pointerType !== "mouse") unlockSound(event);
  },
  { capture: true },
);
// Touch activation is granted on release; click also covers accessible controls.
for (const event of ["touchend", "click", "keydown"])
  document.addEventListener(event, unlockSound, { capture: true });
window.addEventListener("storage", (e) => {
  if (e.key === "uno-audio") {
    gameAudio.setEnabled(e.newValue !== "off");
    updateSoundButton();
  }
});
render();
socket.connect();
