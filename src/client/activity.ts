import {
  colorNames,
  kindNames,
  type ActivityEntry,
  type View,
} from "../shared/types";
import { cardMarkup } from "./cards";

type Viewer = Pick<View, "me" | "players">;
export interface ActivityDescription {
  title: string;
  detail: string;
  glyph: string;
}
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );

/** Describe the state captured with this action, never the current board state. */
export function describeActivity(
  entry: ActivityEntry,
  viewer: Viewer,
): ActivityDescription {
  const name = (seat: number) => {
    if (seat === viewer.me) return "你";
    const player = viewer.players[seat]?.name;
    return player && player !== "等待玩家" ? player : "对方";
  };
  const event = entry.event;
  if (!event)
    return {
      title: "新一局开始",
      detail: `每人 7 张牌，当前颜色为${colorNames[entry.color]}。`,
      glyph: "▶",
    };
  const actor = name(event.actor);
  const other = name(1 - event.actor);
  const target = name(entry.turn);
  const finished = entry.winner !== null;
  const parts: string[] = [];
  let title: string;
  let glyph = "•";
  if (event.card) {
    title = `${actor} 打出了`;
    if (!event.card.color && event.card.kind !== "roulette")
      parts.push(`选择${colorNames[entry.color]}。`);
    if (event.card.kind === "discardAll")
      parts.push(`同色全弃，共打出 ${event.discarded} 张。`);
    if (finished) {
      parts.push(`${name(entry.winner!)}出完所有手牌，获胜。`);
    } else if (event.swapped) {
      parts.push(`双方交换了全部手牌。轮到 ${target}。`);
    } else if (entry.penalty > 0) {
      const challenge =
        event.card.kind === "draw4" || event.card.kind === "wild4";
      parts.push(
        `累计罚抽 +${entry.penalty}。${target} 可以叠加或接受罚抽${challenge ? "，也可以质疑" : ""}。`,
      );
    } else if (event.card.kind === "roulette") {
      parts.push(`等待 ${target} 选择轮盘颜色，再抽到该颜色为止。`);
    } else if (["skip", "reverse", "skipAll"].includes(event.card.kind)) {
      parts.push(`跳过 ${other}，${actor} 再出一张。`);
    } else {
      parts.push(`当前颜色：${colorNames[entry.color]}。轮到 ${target}。`);
    }
    if (event.declaredUno) parts.push("同时喊了 UNO！只剩一张牌。");
  } else if (event.action === "challenge") {
    title = `${actor} 质疑${event.challengeWon ? "成功" : "失败"}`;
    glyph = event.challengeWon ? "✓" : "!";
    if (event.challengeWon) {
      parts.push(
        `${other}承担全部累计罚抽，实际抽 ${event.drawn[1 - event.actor]} 张；${actor}抽 0 张。罚抽已清零。`,
      );
      if (!finished) parts.push(`${actor}继续出牌。`);
    } else {
      parts.push(
        `按累计罚抽 +2 结算，${actor}实际抽 ${event.drawn[event.actor]} 张。罚抽已清零。`,
      );
      if (!finished) parts.push(`跳过 ${actor} 的回合。`);
    }
  } else if (event.action === "uno") {
    title = `${actor} 喊了 UNO！`;
    parts.push("只剩最后一张牌。");
    glyph = "UNO";
  } else if (event.action === "catch") {
    title = `${actor} 抓到漏喊 UNO`;
    parts.push(`${other}罚抽 ${event.drawn[1 - event.actor]} 张。`);
    glyph = "!";
  } else if (event.action === "roulette") {
    title = `${actor} 完成颜色轮盘`;
    parts.push(
      `选择${colorNames[entry.color]}，抽了 ${event.drawn[event.actor]} 张。`,
    );
    if (!finished) parts.push(`跳过 ${actor} 的回合。`);
    glyph = "◉";
  } else {
    const count = event.drawn[event.actor];
    glyph = `+${count}`;
    if ((entry.previousPenalty ?? 0) > 0) {
      title = `${actor} 接受罚抽`;
      parts.push(`累计罚抽 ${entry.previousPenalty} 张，实际抽 ${count} 张。`);
      if (!finished) parts.push(`罚抽已清零，跳过 ${actor} 的回合。`);
    } else {
      title = `${actor} 抽了 ${count} 张牌`;
      if (!finished)
        parts.push(
          entry.turn === event.actor
            ? "抽到了可出的牌，继续出牌。"
            : `牌堆已无可抽的牌，轮到 ${target}。`,
        );
    }
  }
  // Non-play actions can end the round only when a draw reaches the Mercy limit.
  if (finished && !event.card)
    parts.push(
      `${name(1 - entry.winner!)}达到 25 张手牌，${name(entry.winner!)}获胜。`,
    );
  return { title, detail: parts.join(""), glyph };
}

export function activityMarkup(view: View): string {
  if (!view.activity?.length)
    return `<ol class="activity-list activity-list-legacy">${view.log
      .slice()
      .reverse()
      .map((message) => `<li>${escape(message)}</li>`)
      .join("")}</ol>`;
  return `<ol class="activity-list">${view.activity
    .slice()
    .reverse()
    .map((entry) => {
      const description = describeActivity(entry, view);
      const played = entry.event?.card;
      const cardName = played
        ? `${played.color ? colorNames[played.color] : "万能"} ${played.kind === "number" ? played.value : kindNames[played.kind]}`
        : "";
      const icon = entry.event?.card
        ? `<div class="activity-card" role="img" aria-label="${escape(cardName)}">${cardMarkup(entry.event.card)}</div>`
        : `<span class="activity-glyph" aria-hidden="true">${escape(description.glyph)}</span>`;
      // These are already public server messages, not ordinary drawn card faces.
      const publicReveal =
        entry.event?.action === "roulette"
          ? (entry.messages ?? []).filter((message) =>
              message.startsWith("轮盘公开翻牌："),
            )
          : [];
      return `<li class="activity-entry" data-activity-id="${entry.id}">${icon}<div class="activity-copy"><b class="activity-title">${escape(description.title)}</b><p class="activity-effect">${escape(description.detail)}</p>${publicReveal.map((message) => `<p class="activity-public-note">${escape(message)}</p>`).join("")}</div></li>`;
    })
    .join("")}</ol>`;
}
