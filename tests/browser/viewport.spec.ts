import { test, expect, type Browser, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import type { Card, View } from "../../src/shared/types";

const screens = [
  { width: 1366, height: 768 },
  { width: 390, height: 844 },
  { width: 375, height: 667 },
  { width: 320, height: 568 },
  { width: 844, height: 390 },
  { width: 667, height: 375 },
];

async function settled(page: Page) {
  await expect(page.locator("#app")).toHaveAttribute("data-animating", "false");
  await page.evaluate(async () => {
    await Promise.all(
      document.getAnimations().map((a) => a.finished.catch(() => {})),
    );
  });
}
async function assertBoardFits(page: Page) {
  await settled(page);
  const metrics = await page.evaluate(() => {
    const viewport = { width: innerWidth, height: innerHeight };
    const problems: string[] = [];
    const selectors = [
      ".turn-banner",
      ".discard .card",
      ".opponent",
      ".table-info",
      ".hand-heading",
      ".play-controls",
      "#pause",
      "#draw",
      "#auto-uno",
      "#challenge",
      "#catch",
      ".hand .card",
      ".hand .uno-action-label",
      "#resume",
      "#rematch",
    ];
    const hand = document.querySelector(".hand")!.getBoundingClientRect();
    const table = document.querySelector(".table")!.getBoundingClientRect();
    for (const selector of selectors) {
      for (const node of document.querySelectorAll<HTMLElement>(selector)) {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          !rect.width ||
          !rect.height
        ) {
          problems.push(`${selector} is hidden`);
          continue;
        }
        if (
          rect.left < -1 ||
          rect.top < -1 ||
          rect.right > viewport.width + 1 ||
          rect.bottom > viewport.height + 1
        )
          problems.push(
            `${selector} leaves viewport: ${JSON.stringify(rect.toJSON())}`,
          );
        if (
          node.matches(".discard .card") &&
          (rect.left < table.left - 1 ||
            rect.top < table.top - 1 ||
            rect.right > table.right + 1 ||
            rect.bottom > table.bottom + 1)
        )
          problems.push(
            `discard is clipped by table: ${JSON.stringify(rect.toJSON())}`,
          );
        if (
          node.matches(".hand .uno-action-label") &&
          (rect.left < hand.left - 1 ||
            rect.top < hand.top - 1 ||
            rect.right > hand.right + 1 ||
            rect.bottom > hand.bottom + 1)
        )
          problems.push(
            `card caption is clipped by hand area: ${JSON.stringify(rect.toJSON())}`,
          );
        if (node.matches(".hand .card")) {
          if (rect.width < 53 || rect.height < 79)
            problems.push(`card is too small: ${rect.width}x${rect.height}`);
          if (
            rect.left < hand.left - 1 ||
            rect.top < hand.top - 1 ||
            rect.right > hand.right + 1 ||
            rect.bottom > hand.bottom + 1
          )
            problems.push(
              `card is clipped by hand area: ${JSON.stringify(rect.toJSON())}`,
            );
          const hit = document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          );
          if (!hit || !node.contains(hit))
            problems.push(`card ${node.dataset.card} is covered`);
        }
      }
    }
    const banner = document
      .querySelector(".turn-banner")!
      .getBoundingClientRect();
    for (const node of document.querySelectorAll<HTMLElement>(
      ".turn-banner b, .turn-banner p",
    )) {
      if (getComputedStyle(node).display === "none") continue;
      const rect = node.getBoundingClientRect();
      if (
        rect.left < banner.left - 1 ||
        rect.top < banner.top - 1 ||
        rect.right > banner.right + 1 ||
        rect.bottom > banner.bottom + 1
      )
        problems.push(
          `turn message leaves its banner: ${JSON.stringify(rect.toJSON())}`,
        );
    }
    return {
      problems,
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
      viewport,
      scrollX,
      scrollY,
    };
  });
  expect(metrics.problems).toEqual([]);
  expect(metrics.width).toBeLessThanOrEqual(metrics.viewport.width + 1);
  expect(metrics.height).toBeLessThanOrEqual(metrics.viewport.height + 1);
  // Browsers may retain a subpixel-rounding scroll offset when entering the table.
  expect(Math.abs(metrics.scrollX)).toBeLessThanOrEqual(1);
  expect(Math.abs(metrics.scrollY)).toBeLessThanOrEqual(1);
}
async function visitEveryCard(page: Page) {
  const ids = new Set<string>();
  if (await page.locator("#hand-prev").count()) {
    while (await page.locator("#hand-prev").isEnabled())
      await page.locator("#hand-prev").click();
  }
  for (let i = 0; i < 24; i++) {
    await assertBoardFits(page);
    for (const id of await page
      .locator(".hand [data-card]")
      .evaluateAll((cards) => cards.map((c) => c.getAttribute("data-card")!)))
      ids.add(id);
    if (
      !(await page.locator("#hand-next").count()) ||
      !(await page.locator("#hand-next").isEnabled())
    )
      break;
    await page.locator("#hand-next").click();
  }
  return ids;
}
async function pair(
  browser: Browser,
  viewport: { width: number; height: number },
) {
  const ca = await browser.newContext({ viewport });
  const cb = await browser.newContext({ viewport });
  const a = await ca.newPage(),
    b = await cb.newPage();
  await a.goto("/");
  await a.getByRole("button", { name: "创建房间" }).click();
  await expect(a.locator(".waiting")).toBeVisible();
  await expect(a).toHaveURL(/room=/);
  await b.goto(a.url());
  await b.getByRole("button", { name: "加入房间" }).click();
  await expect(a.locator(".game")).toBeVisible();
  await expect(b.locator(".game")).toBeVisible();
  await settled(a);
  await settled(b);
  return { a, b, ca, cb };
}
for (const viewport of screens) {
  test(`real game fits ${viewport.width}x${viewport.height}, including pause controls`, async ({
    browser,
  }) => {
    const { a, b, ca, cb } = await pair(browser, viewport);
    try {
      if (viewport.width === 375 || viewport.width === 390) {
        await expect(a.locator(".hand .card")).toHaveCount(7);
        await expect(b.locator(".hand .card")).toHaveCount(7);
      }
      expect((await visitEveryCard(a)).size).toBe(7);
      expect((await visitEveryCard(b)).size).toBe(7);
      await a.locator("#pause").click();
      await expect(a.locator("#rules")).toBeVisible();
      await a.locator("#close-rules").click();
      await expect(a.locator("#resume")).toBeVisible();
      await assertBoardFits(a);
      await assertBoardFits(b);
      await a.locator("#resume").click();
      await expect(a.locator(".pause-banner")).toHaveCount(0);
      await assertBoardFits(a);
      await a.screenshot({
        path: `/tmp/uno-fit-${viewport.width}x${viewport.height}.png`,
      });
    } finally {
      await ca.close();
      await cb.close();
    }
  });
}

function denseSnapshot(): View {
  const kinds: Card["kind"][] = [
    "number",
    "skip",
    "reverse",
    "draw2",
    "draw4",
    "discardAll",
    "skipAll",
    "wild4",
    "wild6",
    "wild10",
    "roulette",
  ];
  const hand: Card[] = Array.from({ length: 24 }, (_, i) => {
    const kind = kinds[i % kinds.length];
    return {
      id: `dense-${i}`,
      kind,
      color: kind.startsWith("wild") || kind === "roulette" ? null : "red",
      ...(kind === "number" ? { value: i % 10 } : {}),
    };
  });
  return {
    roundId: "viewport-round",
    room: "viewport-room",
    revision: 1,
    event: {
      id: 1,
      action: "play",
      card: { id: "dense-top", kind: "draw4", color: "red" },
      actor: 1,
      drawn: [0, 0],
      swapped: false,
      discarded: 1,
      declaredUno: true,
    },
    me: 0,
    players: [
      {
        name: "玩家甲",
        connected: true,
        count: hand.length,
        deadline: null,
        rematch: false,
      },
      {
        name: "这是一个十六字长的对手昵称测试呀",
        connected: true,
        count: 1,
        deadline: null,
        rematch: false,
      },
    ],
    phase: "playing",
    hand,
    top: { id: "dense-top", kind: "draw4", color: "red" },
    color: "red",
    turn: 0,
    playable: hand.map((card) => card.id),
    penalty: 4,
    lastPenalty: 4,
    challenge: true,
    roulette: false,
    winner: null,
    reason: "",
    pausedBy: null,
    disconnected: false,
    log: ["对方喊了 UNO"],
    canCatch: true,
    unoNeeded: false,
    closed: false,
  };
}
let bundle:
  Promise<{ script: string; style: string; html: string }> | undefined;
async function fixtureBundle() {
  bundle ??= (async () => {
    const result = await build({
      entryPoints: ["src/client/main.ts"],
      bundle: true,
      write: false,
      outfile: "viewport-fixture.js",
      format: "iife",
      platform: "browser",
      plugins: [
        {
          name: "deterministic-transport",
          setup(plugin) {
            plugin.onResolve({ filter: /^socket\.io-client$/ }, () => ({
              path: "socket",
              namespace: "viewport",
            }));
            plugin.onLoad({ filter: /.*/, namespace: "viewport" }, () => ({
              loader: "js",
              contents: `
            export function io() {
              const listeners = new Map();
              let view = structuredClone(window.__viewportFixture);
              window.__viewportCommands = [];
              const emit = (name, value) => { for (const fn of listeners.get(name) ?? []) fn(value); };
              window.__setViewportState = (next) => { view = next; emit('state', view); };
              const socket = {
                connected: false,
                on(name, fn) { const list = listeners.get(name) ?? []; list.push(fn); listeners.set(name, list); return socket; },
                connect() { socket.connected = true; queueMicrotask(() => { emit('connect'); emit('state', view); }); return socket; },
                disconnect() { socket.connected = false; emit('disconnect'); return socket; },
                timeout() { return socket; },
                async emitWithAck(name, command) {
                  window.__viewportCommands.push(structuredClone(command));
                  const action = command.action;
                  if (action?.type === 'pause' || action?.type === 'resume') {
                    view = { ...view, revision: view.revision + 1, pausedBy: action.type === 'pause' ? 0 : null };
                    emit('state', view);
                  }
                  return { ok: true, room: view.room, token: 'fixture-token' };
                }
              };
              return socket;
            }
          `,
            }));
          },
        },
      ],
    });
    return {
      script: result.outputFiles.find((file) => file.path.endsWith(".js"))!
        .text,
      style: result.outputFiles.find((file) => file.path.endsWith(".css"))!
        .text,
      html: (await readFile("src/client/index.html", "utf8")).replace(
        /<script type="module" src="\/main.ts"><\/script>/,
        "",
      ),
    };
  })();
  return bundle;
}
async function denseGame(page: Page, view = denseSnapshot()) {
  const { script, style, html } = await fixtureBundle();
  await page.route("**/viewport-harness", (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
  await page.goto("/viewport-harness");
  await page.addStyleTag({ content: style });
  await page.evaluate((view) => {
    (window as any).__viewportFixture = view;
  }, view);
  await page.addScriptTag({ content: script });
  await expect(page.locator(".game")).toBeVisible();
  await settled(page);
}
for (const viewport of screens) {
  test(`24-card hand stays readable and fully reachable at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await denseGame(page);
    await expect(page.locator("#challenge")).toBeVisible();
    await expect(page.locator("#catch")).toBeVisible();
    await page.screenshot({
      path: `/tmp/uno-dense-${viewport.width}x${viewport.height}.png`,
    });
    expect((await visitEveryCard(page)).size).toBe(24);
    await assertBoardFits(page);
  });
}
test("rotating a dense hand preserves all cards and keeps the round controls in view", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await denseGame(page);
  expect((await visitEveryCard(page)).size).toBe(24);
  await page.setViewportSize({ width: 844, height: 390 });
  expect((await visitEveryCard(page)).size).toBe(24);
  await page.evaluate(() => {
    const w = window as any;
    w.__setViewportState({
      ...w.__viewportFixture,
      revision: 2,
      phase: "finished",
      winner: 0,
      reason: "对手手牌达到 25 张。",
      playable: [],
      canCatch: false,
      challenge: false,
    });
  });
  await expect(page.locator("#rematch")).toBeVisible();
  await assertBoardFits(page);
  await page.locator(".activity summary").click();
  await expect(page.locator(".activity ol")).toBeVisible();
  const documentSize = await page.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    viewport: innerHeight,
  }));
  expect(documentSize.height).toBeLessThanOrEqual(documentSize.viewport + 1);
});

test("jump to a hidden playable card keeps its real identity when playing from a later page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const view = denseSnapshot();
  const playableId = view.hand.at(-1)!.id;
  view.playable = [playableId];
  await denseGame(page, view);
  await expect(page.locator(`.hand [data-card="${playableId}"]`)).toHaveCount(
    0,
  );
  await page.locator("#hand-playable").click();
  await assertBoardFits(page);
  const playable = page.locator(`.hand [data-card="${playableId}"]`);
  await expect(playable).toBeEnabled();
  await playable.click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__viewportCommands
          .filter((command: any) => command.action?.type === "play")
          .map((command: any) => command.action.cardId),
      ),
    )
    .toEqual([playableId]);
});
