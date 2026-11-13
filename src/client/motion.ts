import { colorNames, kindNames, type View } from "../shared/types";
import { cardMarkup } from "./cards";
export interface Feedback {
  title: string;
  detail: string;
  tone: "normal" | "attack" | "success";
}
export function describeEvent(v: View): Feedback {
  const e = v.event;
  if (!e)
    return {
      title: "新一局，手牌已发好",
      detail: "每人 7 张牌。准备好，再开始。",
      tone: "normal",
    };
  const actor = e.actor === v.me ? "你" : v.players[e.actor].name;
  const target = v.turn === v.me ? "你" : v.players[v.turn].name;
  let title = "",
    detail = "",
    tone: Feedback["tone"] = "normal";
  if (e.card) {
    const name =
      e.card.kind === "number" ? String(e.card.value) : kindNames[e.card.kind];
    title = `${actor}打出了 ${e.card.color ? colorNames[e.card.color] + " " : ""}${name}`;
    if (e.swapped) detail = "双方已交换全部手牌，先看看你的新牌。";
    else if (e.discarded > 1) detail = `同色全弃：共打出 ${e.discarded} 张牌。`;
    else if (v.penalty) {
      detail = `罚抽累计 +${v.penalty}。${target}可以叠加${v.challenge ? "、质疑 +4" : ""}，或接受罚抽。`;
      tone = "attack";
    } else if (e.card.kind === "roulette") {
      detail = `等待${target}选择轮盘颜色。`;
      tone = "attack";
    } else if (["skip", "reverse", "skipAll"].includes(e.card.kind))
      detail = `跳过对手，${actor}再出一张。`;
    else detail = `当前颜色：${v.color ? colorNames[v.color] : ""}。`;
  } else if (e.action === "challenge") {
    title = `${actor}质疑${e.challengeWon ? "成功" : "失败"}`;
    const penalized = e.challengeWon ? 1 - e.actor : e.actor;
    const who = penalized === v.me ? "你" : v.players[penalized].name;
    detail = e.challengeWon
      ? `${who}罚抽 ${e.drawn[penalized]} 张；${v.penalty ? `质疑者继续处理此前的 +${v.penalty}。` : "质疑者继续出牌。"}`
      : `${who}罚抽 ${e.drawn[penalized]} 张，已包含额外 2 张，跳过回合。`;
    tone = e.challengeWon ? "success" : "attack";
  } else if (e.action === "uno") {
    title = `${actor}喊了 UNO！`;
    detail = "只剩最后一张牌。";
    tone = "attack";
  } else if (e.action === "catch") {
    title = `${actor}抓到了漏喊 UNO`;
    detail = "对手罚抽 2 张。";
    tone = "attack";
  } else if (e.action === "roulette") {
    title = `${actor}完成颜色轮盘`;
    detail = `选定${v.color ? colorNames[v.color] : ""}，抽了 ${e.drawn[e.actor]} 张，跳过回合。`;
    tone = "attack";
  } else {
    const n = e.drawn[e.actor];
    title = `${actor}抽了 ${n} 张牌`;
    detail =
      v.turn === e.actor
        ? "抽到了可出的牌，请继续出牌。"
        : "罚抽已结算，跳过本回合。";
  }
  if (e.declaredUno && e.action !== "uno") detail += " UNO！只剩一张牌。";
  if (v.phase === "finished") {
    detail =
      v.winner === v.me ? "你赢了！" + v.reason : "本局结束。" + v.reason;
    tone = v.winner === v.me ? "success" : "normal";
  }
  return { title, detail, tone };
}
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const runs = new Set<MotionRun>();
/** Every presentation owns its nodes, animations and timers, including cancellation. */
class MotionRun {
  aborted = false;
  nodes = new Set<HTMLElement>();
  animations = new Set<Animation>();
  hidden = new Set<HTMLElement>();
  pending = new Set<() => void>();
  constructor(private signal?: AbortSignal) {
    runs.add(this);
    signal?.addEventListener("abort", this.cancel, { once: true });
    if (signal?.aborted) this.cancel();
  }
  cancel = () => {
    this.aborted = true;
    this.finish();
  };
  finish() {
    for (const resolve of this.pending) resolve();
    this.pending.clear();
    for (const a of this.animations) a.cancel();
    this.animations.clear();
    for (const node of this.nodes) node.remove();
    this.nodes.clear();
    for (const node of this.hidden) node.classList.remove("departing");
    this.hidden.clear();
    this.signal?.removeEventListener("abort", this.cancel);
    runs.delete(this);
  }
  add(node: HTMLElement) {
    if (this.aborted) return node;
    this.nodes.add(node);
    document.body.append(node);
    return node;
  }
  hide(node: HTMLElement | undefined | null) {
    if (node && !reduced()) {
      this.hidden.add(node);
      node.classList.add("departing");
    }
  }
  wait(ms: number): Promise<void> {
    if (this.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const done = () => {
        clearTimeout(timer);
        this.pending.delete(done);
        resolve();
      };
      this.pending.add(done);
      timer = setTimeout(done, ms);
    });
  }
  async animate(node: HTMLElement, frames: Keyframe[], ms: number, delay = 0) {
    if (this.aborted || reduced()) return;
    const a = node.animate(frames, {
      duration: ms,
      delay,
      easing: "cubic-bezier(.2,.7,.25,1)",
      fill: "forwards",
    });
    this.animations.add(a);
    try {
      await a.finished;
    } catch {
      /* cancellation is a normal state change */
    }
  }
}
export function cancelMotion() {
  for (const run of [...runs]) run.cancel();
}
function raw(selector: string) {
  return document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
}
/** Keep feedback visible even when the real discard pile is above a scrolled hand. */
function anchor(
  box: DOMRect | undefined,
  kind: "seat" | "table" = "seat",
): DOMRect {
  const width = Math.max(64, Math.min(box?.width ?? 80, 94)),
    height = width * 1.5;
  let x = (box ? box.x + box.width / 2 : innerWidth / 2) - width / 2;
  let y = (box ? box.y + box.height / 2 : innerHeight / 2) - height / 2;
  if (
    kind === "table" &&
    (!box || box.bottom < 40 || box.top > innerHeight - 40)
  )
    y = innerHeight * 0.35;
  x = Math.max(12, Math.min(innerWidth - width - 12, x));
  y = Math.max(12, Math.min(innerHeight - height - 16, y));
  return new DOMRect(x, y, width, height);
}
function seat(player: number, v: View) {
  return anchor(raw(player === v.me ? ".hand-heading" : ".opponent .avatar"));
}
const backMarkup = "<b>UNO</b><small>NO MERCY</small>";
function faceNode(card: NonNullable<View["top"]>) {
  const holder = document.createElement("div");
  holder.innerHTML = cardMarkup(card);
  return holder.firstElementChild as HTMLElement;
}
async function fly(
  run: MotionRun,
  from: DOMRect,
  to: DOMRect,
  source?: HTMLElement,
  delay = 0,
  lane = 0,
) {
  if (run.aborted || reduced()) return;
  const node = source
    ? (source.cloneNode(true) as HTMLElement)
    : document.createElement("div");
  node.tabIndex = -1;
  node.removeAttribute("id");
  node.removeAttribute("data-card");
  node.removeAttribute("disabled");
  node.setAttribute("aria-hidden", "true");
  node.classList.remove("unplayable", "departing", "pending-card");
  node.querySelector(".new-card-tag")?.remove();
  if (!source) {
    node.className = "motion-back";
    node.innerHTML = backMarkup;
  }
  node.classList.add("flying-card");
  Object.assign(node.style, {
    left: `${from.x}px`,
    top: `${from.y}px`,
    width: `${from.width}px`,
    height: `${from.height}px`,
    margin: "0",
  });
  run.add(node);
  const dx = to.x - from.x,
    dy = to.y - from.y;
  await run.animate(
    node,
    [
      { transform: "translate(0,0) rotate(-7deg)" },
      {
        offset: 0.55,
        transform: `translate(${dx * 0.55 + lane}px,${dy * 0.55 - 28}px) rotate(8deg) scale(1.08)`,
      },
      { transform: `translate(${dx}px,${dy}px) rotate(5deg)` },
    ],
    460,
    delay,
  );
}
function effect(
  run: MotionRun,
  kind: string,
  title: string,
  subtitle: string,
  icon: string,
) {
  if (run.aborted) return;
  const node = document.createElement("div");
  node.className = "game-effect";
  node.dataset.effect = kind;
  node.setAttribute("aria-hidden", "true");
  const mark = document.createElement("span");
  mark.className = "effect-mark";
  mark.textContent = icon;
  const text = document.createElement("div");
  const heading = document.createElement("strong");
  heading.textContent = title;
  const detail = document.createElement("small");
  detail.textContent = subtitle;
  text.append(heading, detail);
  node.append(mark, text);
  run.add(node);
  void run.animate(
    node,
    [
      { opacity: 0.5, transform: "translateX(-50%) scale(.92)" },
      { opacity: 1, transform: "translateX(-50%) scale(1)" },
    ],
    180,
  );
  return node;
}
export async function opening(
  next: View,
  signal: AbortSignal,
  hooks: { reveal?: () => void } = {},
) {
  const run = new MotionRun(signal);
  try {
    effect(
      run,
      "deal",
      "新一局 · 翻开首张牌",
      "数字牌决定起始颜色，准备出牌。",
      "✦",
    );
    if (!next.top || run.aborted) return;
    if (reduced()) {
      hooks.reveal?.();
      await run.wait(650);
      return;
    }
    const from = anchor(raw(".draw-pile")),
      to = anchor(raw(".discard"), "table");
    const node = document.createElement("div");
    node.className = "opening-card flying-card";
    node.setAttribute("aria-hidden", "true");
    node.innerHTML = `<div class="flip-card-inner"><div class="flip-back motion-back">${backMarkup}</div><div class="flip-front">${cardMarkup(next.top)}</div></div>`;
    Object.assign(node.style, {
      left: `${from.x}px`,
      top: `${from.y}px`,
      width: `${to.width}px`,
      height: `${to.height}px`,
    });
    run.add(node);
    await run.animate(
      node,
      [
        { transform: "translate(0,0) rotate(-7deg)" },
        {
          transform: `translate(${to.x - from.x}px,${to.y - from.y}px) rotate(5deg)`,
        },
      ],
      360,
    );
    if (run.aborted) return;
    hooks.reveal?.();
    await run.animate(
      node.querySelector<HTMLElement>(".flip-card-inner")!,
      [{ transform: "rotateY(0deg)" }, { transform: "rotateY(180deg)" }],
      560,
    );
    await run.wait(220);
  } finally {
    run.finish();
  }
}
/** Only an accepted public event is animated; private opponent cards remain backs. */
export async function transition(
  previous: View,
  next: View,
  signal: AbortSignal,
  hooks: { effect?: () => void } = {},
) {
  const run = new MotionRun(signal),
    e = next.event;
  try {
    if (!e || run.aborted) return;
    const actor = e.actor === next.me ? "你" : next.players[e.actor].name;
    if (e.card) {
      const source =
        e.actor === next.me
          ? document.querySelector<HTMLElement>(
              `.hand [data-card="${e.card.id}"]`,
            )
          : null;
      const from = source
          ? anchor(source.getBoundingClientRect())
          : seat(e.actor, next),
        to = anchor(raw(".discard"), "table");
      const label = effect(
        run,
        "play",
        `${actor}出牌`,
        `${e.card.color ? colorNames[e.card.color] + " " : ""}${e.card.kind === "number" ? e.card.value : kindNames[e.card.kind]}`,
        "↗",
      );
      run.hide(source);
      const extras =
        e.card.kind === "discardAll" && e.actor === next.me
          ? previous.hand
              .filter((c) => c.color === e.card!.color && c.id !== e.card!.id)
              .slice(0, 4)
          : [];
      await Promise.all([
        fly(run, from, to, source ?? faceNode(e.card)),
        ...extras.map((card, i) => {
          const el = document.querySelector<HTMLElement>(
            `.hand [data-card="${card.id}"]`,
          );
          run.hide(el);
          return fly(
            run,
            anchor(el?.getBoundingClientRect()),
            to,
            el ?? undefined,
            (i + 1) * 35,
          );
        }),
      ]);
      if (reduced()) await run.wait(180);
      label?.remove();
    }
    if (run.aborted) return;
    const skip =
      e.card &&
      ["skip", "reverse", "skipAll"].includes(e.card.kind) &&
      next.phase !== "finished";
    if (e.swapped) {
      hooks.effect?.();
      effect(
        run,
        "swap",
        "交换全部手牌",
        "双方手牌对调，换手完成后再继续。",
        "⇄",
      );
      await Promise.all([
        fly(run, seat(0, next), seat(1, next), undefined, 0, -38),
        fly(run, seat(1, next), seat(0, next), undefined, 0, 38),
        run.wait(650),
      ]);
    } else if (skip) {
      hooks.effect?.();
      effect(
        run,
        "skip",
        e.actor === next.me ? "对手被跳过" : "你被跳过",
        e.actor === next.me
          ? "还是你的回合，再出一张！"
          : `${actor}继续出牌，请等待。`,
        "⊘",
      );
      const target = document.querySelector<HTMLElement>(
        e.actor === next.me ? ".opponent" : ".hand-heading",
      );
      if (target)
        await run.animate(
          target,
          [
            { filter: "brightness(1)" },
            { filter: "brightness(.55)" },
            { filter: "brightness(1)" },
          ],
          400,
        );
      await run.wait(reduced() ? 650 : 300);
    } else if (e.discarded > 1) {
      hooks.effect?.();
      effect(
        run,
        "discard",
        `一次打出 ${e.discarded} 张`,
        "同色手牌已全部弃掉。",
        "⇊",
      );
      await run.wait(400);
    } else if (e.action === "challenge") {
      effect(
        run,
        "challenge",
        e.challengeWon ? "质疑成功" : "质疑失败",
        describeEvent(next).detail,
        e.challengeWon ? "✓" : "!",
      );
    }
    if (run.aborted) return;
    const draws: Promise<void>[] = [];
    for (let p = 0; p < 2; p++)
      if (e.drawn[p] > 0) {
        // The challenge caption already explains its penalty. Keep that result
        // readable while cards move instead of covering it with a second badge.
        if (e.action !== "challenge")
          effect(
            run,
            "draw",
            `${p === next.me ? "你" : next.players[p].name}抽 ${e.drawn[p]} 张`,
            "新牌即将加入手牌。",
            "+",
          );
        for (let i = 0; i < Math.min(e.drawn[p], 5); i++)
          draws.push(
            fly(
              run,
              anchor(raw(".draw-pile")),
              seat(p, next),
              undefined,
              i * 70,
            ),
          );
      }
    if (draws.length || e.drawn.some((n) => n > 0))
      await Promise.all([...draws, run.wait(650)]);
    else if (!e.swapped && !skip) await run.wait(e.card ? 180 : 550);
  } finally {
    run.finish();
  }
}
/** Add a short highlight; never set hand-card opacity to zero while waiting. */
export function settle(previous: View | null, next: View) {
  if (reduced()) return;
  const run = new MotionRun(),
    prior = new Set(previous?.hand.map((c) => c.id) ?? []),
    jobs: Promise<void>[] = [];
  document
    .querySelectorAll<HTMLElement>(".hand [data-card]")
    .forEach((node, i) => {
      if (!prior.has(node.dataset.card!))
        jobs.push(
          run.animate(
            node,
            [
              { transform: "translateY(9px) scale(.97)" },
              { transform: "translateY(0) scale(1)" },
            ],
            260,
            Math.min(i, 5) * 25,
          ),
        );
    });
  if (previous?.top?.id !== next.top?.id) {
    const top = document.querySelector<HTMLElement>(".discard > .card");
    if (top)
      jobs.push(
        run.animate(
          top,
          [{ transform: "scale(1.06)" }, { transform: "scale(1)" }],
          200,
        ),
      );
  }
  if (next.phase === "finished" && previous?.phase !== "finished") {
    const result = document.querySelector<HTMLElement>(".result");
    if (result)
      jobs.push(
        run.animate(
          result,
          [{ transform: "translateY(9px)" }, { transform: "translateY(0)" }],
          300,
        ),
      );
  }
  void Promise.all(jobs).finally(() => run.finish());
}
