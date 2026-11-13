import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import type { Card, View } from "../../src/shared/types";

const card = (id: string, kind: Card["kind"], value?: number): Card => ({
  id,
  kind,
  color: "red",
  ...(value === undefined ? {} : { value }),
});
function snapshot(hand: Card[]): View {
  return {
    event: null,
    room: "presentation-test",
    revision: 1,
    me: 0,
    players: [
      {
        name: "你",
        connected: true,
        count: hand.length,
        deadline: null,
        rematch: false,
      },
      {
        name: "对方",
        connected: true,
        count: 4,
        deadline: null,
        rematch: false,
      },
    ],
    phase: "playing",
    hand,
    top: card("previous-top", "number", 5),
    color: "red",
    turn: 0,
    playable: hand.map((c) => c.id),
    penalty: 0,
    lastPenalty: 0,
    challenge: false,
    roulette: false,
    winner: null,
    reason: "",
    pausedBy: null,
    disconnected: false,
    log: [],
    canCatch: false,
    unoNeeded: false,
    closed: false,
    roundId: "fixture-round",
  };
}
function snapshots(kind: Card["kind"], actor = 0, swapped = false) {
  const played = card(
    "played",
    kind,
    kind === "number" ? (swapped ? 7 : 3) : undefined,
  );
  const previous = snapshot(
    actor === 0
      ? [played, card("kept-a", "number", 6), card("kept-b", "number", 8)]
      : [card("kept-a", "number", 6), card("kept-b", "number", 8)],
  );
  const next: View = {
    ...previous,
    revision: 2,
    turn: kind === "skip" ? actor : 1 - actor,
    hand: actor === 0 ? previous.hand.slice(1) : previous.hand,
    top: played,
    event: {
      id: 1,
      action: "play",
      actor,
      card: played,
      drawn: [0, 0],
      swapped,
      discarded: 1,
      declaredUno: false,
    },
  };
  return { previous, next };
}
async function harness(page: Page, previous: View) {
  const result = await build({
    stdin: {
      contents:
        'export * from "./src/client/motion.ts"; export { cardMarkup } from "./src/client/cards.ts";',
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "iife",
    globalName: "Presentation",
    platform: "browser",
  });
  await page.route("**/presentation-harness", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><body><main class="game" id="fixture"></main></body></html>',
    }),
  );
  await page.goto("/presentation-harness");
  await page.addStyleTag({
    content: await readFile("src/client/style.css", "utf8"),
  });
  await page.addStyleTag({
    content: await readFile("src/client/feedback.css", "utf8"),
  });
  await page.addStyleTag({
    content:
      ".game{max-width:900px;margin:20px auto}.table{min-height:310px}.hand{min-height:160px}.opponent{height:50px}.discard{width:94px;height:141px}.draw-pile{width:94px;height:141px}.hand-section{margin-top:28px}",
  });
  await page.addScriptTag({ content: result.outputFiles[0].text });
  await page.evaluate((previous) => {
    const api = (window as any).Presentation;
    document.querySelector("#fixture")!.innerHTML =
      `<section class="table"><div class="opponent"><span class="avatar">对</span><div class="back-cards"><i>UNO</i></div></div><div class="table-center"><div class="draw-pile"><span>UNO</span><small>NO MERCY</small></div><div class="discard">${api.cardMarkup(previous.top)}</div></div></section><section class="hand-section"><div class="hand-heading">你的手牌</div><div class="hand">${previous.hand.map((c: Card) => api.cardMarkup(c, true, true)).join("")}</div></section>`;
    (window as any).effects = 0;
    (window as any).reveals = 0;
    (window as any).completed = false;
    (window as any).controller = new AbortController();
  }, previous);
}
async function startTransition(page: Page, previous: View, next: View) {
  await page.evaluate(
    ({ previous, next }) => {
      const w = window as any;
      w.running = w.Presentation.transition(
        previous,
        next,
        w.controller.signal,
        { effect: () => w.effects++ },
      ).then(() => {
        w.completed = true;
      });
    },
    { previous, next },
  );
}
async function completed(page: Page) {
  await expect
    .poll(() => page.evaluate(() => (window as any).completed))
    .toBe(true);
  await expect(
    page.locator(".flying-card,.game-effect,.opening-card,.departing"),
  ).toHaveCount(0);
  const hiddenCards = await page.locator(".hand .card").evaluateAll(
    (cards) =>
      cards.filter((c) => {
        const style = getComputedStyle(c);
        return style.visibility === "hidden" || Number(style.opacity) === 0;
      }).length,
  );
  expect(hiddenCards).toBe(0);
}

for (const actor of [0, 1]) {
  test(`${actor === 0 ? "your" : "opponent"} accepted play flies its public face to the table`, async ({
    page,
  }) => {
    const { previous, next } = snapshots("number", actor);
    await harness(page, previous);
    await startTransition(page, previous, next);
    await expect(page.locator(".flying-card").first()).toBeVisible();
    await expect(page.locator(".flying-card .card-art")).toHaveCount(1);
    expect(await page.locator(".hand .card").count()).toBe(
      previous.hand.length,
    );
    await completed(page);
  });
}
test("skip has an explicit visible effect and a distinct effect sound timing callback", async ({
  page,
}) => {
  const { previous, next } = snapshots("skip");
  await harness(page, previous);
  await startTransition(page, previous, next);
  await expect(page.locator('.game-effect[data-effect="skip"]')).toBeVisible();
  await expect(page.locator(".game-effect")).toContainText("跳过");
  await expect.poll(() => page.evaluate(() => (window as any).effects)).toBe(1);
  await completed(page);
});
test("challenge result remains visible while the penalty cards move", async ({
  page,
}) => {
  const previous = snapshot([card("held", "number", 5)]);
  const next: View = {
    ...previous,
    event: {
      id: 1,
      action: "challenge",
      actor: 0,
      drawn: [6, 0],
      swapped: false,
      discarded: 0,
      declaredUno: false,
      challengeWon: false,
    },
  };
  await harness(page, previous);
  await startTransition(page, previous, next);
  await expect(page.locator(".flying-card").first()).toBeVisible();
  await expect(page.locator(".game-effect")).toHaveCount(1);
  await expect(page.locator(".game-effect")).toContainText("质疑失败");
  await expect(page.locator(".game-effect")).toContainText("6");
  await completed(page);
});
test("swap shows a visible exchange and cancels cleanly mid-effect", async ({
  page,
}) => {
  const { previous, next } = snapshots("number", 0, true);
  await harness(page, previous);
  await startTransition(page, previous, next);
  await expect(page.locator('.game-effect[data-effect="swap"]')).toBeVisible();
  await expect(page.locator(".game-effect")).toContainText("交换");
  await expect.poll(() => page.evaluate(() => (window as any).effects)).toBe(1);
  await page.evaluate(() => {
    const w = window as any;
    w.controller.abort();
  });
  await completed(page);
});
test("opening reveals the first card and reduced motion keeps the hand readable", async ({
  page,
}) => {
  const previous = snapshot([
    card("held-a", "number", 1),
    card("held-b", "number", 8),
  ]);
  await harness(page, previous);
  await page.evaluate((v) => {
    const w = window as any;
    w.running = w.Presentation.opening(v, w.controller.signal, {
      reveal: () => w.reveals++,
    }).then(() => (w.completed = true));
  }, previous);
  await expect(page.locator(".opening-card")).toBeVisible();
  await expect(page.locator(".opening-card .flip-card-inner")).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => (window as any).reveals)).toBe(1);
  await completed(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate((v) => {
    const w = window as any;
    w.completed = false;
    w.controller = new AbortController();
    w.running = w.Presentation.opening(v, w.controller.signal, {
      reveal: () => w.reveals++,
    }).then(() => (w.completed = true));
  }, previous);
  await expect(page.locator(".flying-card")).toHaveCount(0);
  await completed(page);
});
test("hand entrance never hides or collapses cards while it is staggered", async ({
  page,
}) => {
  const previous = snapshot(
    Array.from({ length: 24 }, (_, i) => card(`hand-${i}`, "number", i % 10)),
  );
  await harness(page, previous);
  const visibility = await page.evaluate((v) => {
    (window as any).Presentation.settle(null, v);
    return [...document.querySelectorAll<HTMLElement>(".hand .card")].map(
      (el) => ({
        opacity: Number(getComputedStyle(el).opacity),
        width: el.getBoundingClientRect().width,
        svgHeight: el.querySelector("svg")!.getBoundingClientRect().height,
      }),
    );
  }, previous);
  expect(visibility).toHaveLength(24);
  for (const card of visibility) {
    expect(card.opacity).toBeGreaterThan(0);
    expect(card.width).toBeGreaterThan(50);
    expect(card.svgHeight).toBeGreaterThan(70);
  }
  await page.evaluate(() => (window as any).Presentation.cancelMotion());
});
test("both new seats see the opening flip; refreshing the same seat does not replay it", async ({
  browser,
}) => {
  const ca = await browser.newContext(),
    cb = await browser.newContext();
  for (const context of [ca, cb])
    await context.addInitScript(() => {
      (window as any).sawOpening = false;
      document.addEventListener("DOMContentLoaded", () =>
        new MutationObserver(() => {
          if (
            document.querySelector(".opening-card") ||
            document.querySelector('.game[data-opening="true"]')
          )
            (window as any).sawOpening = true;
        }).observe(document.documentElement, {
          subtree: true,
          attributes: true,
          childList: true,
        }),
      );
    });
  const a = await ca.newPage(),
    b = await cb.newPage();
  try {
    await a.goto("/");
    await a.getByRole("button", { name: "创建房间" }).click();
    await expect(a.locator(".waiting")).toBeVisible();
    await expect(a).toHaveURL(/\?room=/);
    await b.goto(a.url());
    await b.getByRole("button", { name: "加入房间" }).click();
    await expect
      .poll(() => a.evaluate(() => (window as any).sawOpening))
      .toBe(true);
    await expect
      .poll(() => b.evaluate(() => (window as any).sawOpening))
      .toBe(true);
    for (const p of [a, b]) {
      await expect(p.locator("#app")).toHaveAttribute(
        "data-animating",
        "false",
      );
      await expect(p.locator(".hand .card")).toHaveCount(7);
    }
    const ids = await b
      .locator(".hand [data-card]")
      .evaluateAll((cards) => cards.map((c) => c.getAttribute("data-card")));
    await b.reload();
    await expect(b.locator(".hand .card")).toHaveCount(7);
    expect(await b.evaluate(() => (window as any).sawOpening)).toBe(false);
    expect(
      await b
        .locator(".hand [data-card]")
        .evaluateAll((cards) => cards.map((c) => c.getAttribute("data-card"))),
    ).toEqual(ids);
  } finally {
    await ca.close();
    await cb.close();
  }
});
