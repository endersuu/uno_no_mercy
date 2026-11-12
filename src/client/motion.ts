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
    detail = e.challengeWon
      ? "出 +4 的玩家罚抽 4 张；质疑者继续回合。"
      : "质疑者接受累计罚抽，并额外抽 2 张，跳过回合。";
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
function rect(selector: string) {
  return document.querySelector(selector)?.getBoundingClientRect();
}
function seat(p: number, v: View) {
  return p === v.me ? rect(".hand") : rect(".opponent .avatar");
}
const active = new Set<Animation>();
const ghosts = new Set<HTMLElement>();
export function cancelMotion() {
  for (const a of active) a.cancel();
  active.clear();
  for (const el of ghosts) el.remove();
  ghosts.clear();
  document
    .querySelectorAll(".departing")
    .forEach((el) => el.classList.remove("departing"));
}
async function animate(
  el: HTMLElement,
  frames: Keyframe[],
  duration: number,
  delay = 0,
) {
  const animation = el.animate(frames, {
    duration,
    delay,
    easing: "cubic-bezier(.2,.75,.25,1)",
    fill: "both",
  });
  active.add(animation);
  try {
    await animation.finished;
  } catch {
  } finally {
    animation.cancel();
    active.delete(animation);
  }
}
async function fly(
  from: DOMRect | undefined,
  to: DOMRect | undefined,
  source?: HTMLElement,
  delay = 0,
  reverse = false,
) {
  if (!from || !to || reduced()) return;
  const el = source
    ? (source.cloneNode(true) as HTMLElement)
    : document.createElement("div");
  el.tabIndex = -1;
  el.removeAttribute("id");
  el.removeAttribute("data-card");
  el.removeAttribute("disabled");
  el.setAttribute("aria-hidden", "true");
  if (!source) {
    el.className = "motion-back";
    el.innerHTML = "<b>UNO</b><small>NO MERCY</small>";
  }
  el.classList.remove("unplayable", "departing");
  el.classList.add("flying-card");
  const width = Math.min(from.width, 94),
    height = width * 1.46;
  const start = {
    x: from.x + (from.width - width) / 2,
    y: from.y + (from.height - height) / 2,
  };
  const end = {
    x: to.x + (to.width - width) / 2,
    y: to.y + (to.height - height) / 2,
  };
  Object.assign(el.style, {
    position: "fixed",
    left: `${start.x}px`,
    top: `${start.y}px`,
    width: `${width}px`,
    height: `${height}px`,
    margin: "0",
  });
  document.body.append(el);
  ghosts.add(el);
  await animate(
    el,
    [
      { transform: "translate(0,0) rotate(-8deg) scale(1)", opacity: 1 },
      {
        offset: 0.62,
        transform: `translate(${(end.x - start.x) * 0.65}px,${(end.y - start.y) * 0.65 - 35}px) rotate(${reverse ? -8 : 10}deg) scale(1.12)`,
        opacity: 1,
      },
      {
        transform: `translate(${end.x - start.x}px,${end.y - start.y}px) rotate(${reverse ? -4 : 6}deg) scale(1)`,
        opacity: 1,
      },
    ],
    420,
    delay,
  );
  el.remove();
  ghosts.delete(el);
}
/** Animate only public facts; opponent draws always use card backs. */
export async function transition(
  previous: View,
  next: View,
  signal: AbortSignal,
) {
  const e = next.event;
  if (!e) return;
  const started = performance.now();
  if (e.card) {
    const source =
      e.actor === next.me
        ? document.querySelector<HTMLElement>(`[data-card="${e.card.id}"]`)
        : undefined;
    // The face of an opponent's played card is public only after server acceptance.
    let face: HTMLElement | undefined = source ?? undefined;
    if (!face) {
      const holder = document.createElement("div");
      holder.innerHTML = cardMarkup(e.card);
      face = holder.firstElementChild as HTMLElement | undefined;
    }

    const extras =
      e.card.kind === "discardAll" && e.actor === next.me
        ? previous.hand
            .filter((c) => c.color === e.card!.color && c.id !== e.card!.id)
            .slice(0, 4)
        : [];
    const from = source?.getBoundingClientRect() ?? seat(e.actor, next);
    if (!reduced()) source?.classList.add("departing");
    await Promise.all([
      fly(from, rect(".discard"), face),
      ...extras.map((c, i) => {
        const el = document.querySelector<HTMLElement>(`[data-card="${c.id}"]`);
        if (!reduced()) el?.classList.add("departing");
        return fly(
          el?.getBoundingClientRect(),
          rect(".discard"),
          el ?? undefined,
          35 * (i + 1),
        );
      }),
    ]);
  }
  if (signal.aborted) return;
  if (e.swapped)
    await Promise.all([
      fly(seat(0, next), seat(1, next), undefined, 0, true),
      fly(seat(1, next), seat(0, next)),
    ]);
  if (signal.aborted) return;
  const draws: Promise<void>[] = [];
  for (let p = 0; p < 2; p++)
    for (let i = 0; i < Math.min(e.drawn[p], 5); i++)
      draws.push(fly(rect(".draw-pile"), seat(p, next), undefined, i * 65));
  await Promise.all(draws);
  // Same readable beat for reduced-motion users; no flying or shaking.
  const remaining = 620 - (performance.now() - started);
  if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
}
export function settle(previous: View | null, next: View) {
  if (reduced()) return;
  const prior = new Set(previous?.hand.map((c) => c.id) ?? []);
  document
    .querySelectorAll<HTMLElement>(".hand [data-card]")
    .forEach((el, i) => {
      if (!prior.has(el.dataset.card!))
        void animate(
          el,
          [
            { opacity: 0, transform: "translateY(18px) scale(.9)" },
            { opacity: 1, transform: "translateY(0) scale(1)" },
          ],
          280,
          Math.min(i, 7) * 30,
        );
    });
  if (previous?.top?.id !== next.top?.id) {
    const top = document.querySelector<HTMLElement>(".discard .card");
    if (top)
      void animate(
        top,
        [{ transform: "scale(1.09)" }, { transform: "scale(1)" }],
        220,
      );
  }
  if (next.phase === "finished" && previous?.phase !== "finished") {
    const result = document.querySelector<HTMLElement>(".result");
    if (result)
      void animate(
        result,
        [
          { opacity: 0, transform: "translateY(14px)" },
          { opacity: 1, transform: "translateY(0)" },
        ],
        380,
      );
  }
}
