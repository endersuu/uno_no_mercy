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
    const handNode = document.querySelector<HTMLElement>(".hand")!;
    const hand = handNode.getBoundingClientRect();
    const portrait = matchMedia(
      "(max-width: 650px) and (orientation: portrait)",
    ).matches;
    const scrollingHand =
      portrait && handNode.scrollHeight > handNode.clientHeight + 1;
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
        const handPart = node.matches(".hand .card, .hand .uno-action-label");
        if (
          rect.left < -1 ||
          rect.right > viewport.width + 1 ||
          ((!handPart || !scrollingHand) &&
            (rect.top < -1 || rect.bottom > viewport.height + 1))
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
            rect.right > hand.right + 1 ||
            (!scrollingHand &&
              (rect.top < hand.top - 1 || rect.bottom > hand.bottom + 1)))
        )
          problems.push(
            `card caption is clipped by hand area: ${JSON.stringify(rect.toJSON())}`,
          );
        if (node.matches(".hand .card")) {
          const art = node.querySelector<SVGSVGElement>(".card-art");
          if (!art) problems.push(`card ${node.dataset.card} has no SVG face`);
          else {
            const artRect = art.getBoundingClientRect();
            const artStyle = getComputedStyle(art);
            for (const [part, partStyle] of [
              ["button", style],
              ["SVG", artStyle],
            ] as const) {
              if (
                partStyle.display === "none" ||
                partStyle.visibility !== "visible" ||
                Number(partStyle.opacity) <= 0 ||
                [
                  ...partStyle.filter.matchAll(
                    /(?:opacity|brightness)\(([^)]+)\)/g,
                  ),
                ].some(([, value]) => Number.parseFloat(value) === 0)
              )
                problems.push(`card ${node.dataset.card} ${part} is invisible`);
            }
            if (
              artRect.width <= 0 ||
              artRect.height <= 0 ||
              Math.abs(artRect.width - rect.width) > 1 ||
              Math.abs(artRect.height - rect.height) > 1 ||
              Math.abs(artRect.left - rect.left) > 1 ||
              Math.abs(artRect.top - rect.top) > 1
            )
              problems.push(
                `card ${node.dataset.card} SVG does not fill its button: ${JSON.stringify({ card: rect.toJSON(), svg: artRect.toJSON() })}`,
              );
          }
          if (
            rect.width < (portrait ? 44 : 53) ||
            rect.height < (portrait ? 66 : 79)
          )
            problems.push(`card is too small: ${rect.width}x${rect.height}`);
          if (
            rect.left < hand.left - 1 ||
            rect.right > hand.right + 1 ||
            (!scrollingHand &&
              (rect.top < hand.top - 1 || rect.bottom > hand.bottom + 1))
          )
            problems.push(
              `card is clipped by hand area: ${JSON.stringify(rect.toJSON())}`,
            );
          if (
            !scrollingHand ||
            (rect.top >= hand.top && rect.bottom <= hand.bottom)
          ) {
            const hit = document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            );
            if (!hit || !node.contains(hit))
              problems.push(`card ${node.dataset.card} is covered`);
          }
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
  const portrait = await page.evaluate(
    () => matchMedia("(max-width: 650px) and (orientation: portrait)").matches,
  );
  if (portrait) {
    await expect(page.locator(".hand-navigation")).toBeHidden();
    const cards = await page
      .locator(".hand [data-card]")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-card")!),
      );
    for (const id of cards) {
      const card = page.locator(`.hand [data-card="${id}"]`);
      await card.scrollIntoViewIfNeeded();
      const visible = await card.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const hand = node.closest(".hand")!.getBoundingClientRect();
        const caption = node
          .querySelector(".uno-action-label")
          ?.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.x + rect.width / 2,
          rect.y + rect.height / 2,
        );
        const reachable =
          rect.top >= hand.top - 1 &&
          rect.bottom <= hand.bottom + 1 &&
          rect.left >= hand.left - 1 &&
          rect.right <= hand.right + 1 &&
          (!caption || caption.bottom <= hand.bottom + 1) &&
          !!hit &&
          node.contains(hit);
        return {
          reachable,
          card: rect.toJSON(),
          hand: hand.toJSON(),
          caption: caption?.toJSON(),
          hit: hit?.tagName,
        };
      });
      expect(
        visible.reachable,
        `card ${id} must be fully reachable in the hand scroll area: ${JSON.stringify(visible)}`,
      ).toBe(true);
      ids.add(id);
    }
    await assertBoardFits(page);
    return ids;
  }
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

for (const viewport of [
  { width: 393, height: 852 },
  { width: 402, height: 874 },
  { width: 430, height: 932 },
  { width: 440, height: 956 },
]) {
  test(`portrait ${viewport.width}x${viewport.height} displays 24–30 cards together without paging or scrolling`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    for (const count of [24, 25, 30]) {
      const view = denseSnapshot(count);
      if (count >= 25)
        Object.assign(view, {
          phase: "finished",
          winner: 1,
          playable: [],
          canCatch: false,
          challenge: false,
          reason: "手牌达到 25 张，本局结束。",
        });
      await denseGame(page, view);
      await expect(page.locator(".hand [data-card]")).toHaveCount(count);
      await expect(page.locator(".hand-navigation")).toBeHidden();
      const hand = await page.locator(".hand").evaluate((node) => ({
        height: node.clientHeight,
        content: node.scrollHeight,
      }));
      expect(hand.content).toBeLessThanOrEqual(hand.height + 1);
      expect((await visitEveryCard(page)).size).toBe(count);
      await page.screenshot({
        path: `/tmp/uno-portrait-${viewport.width}x${viewport.height}-${count}.png`,
      });
    }
  });
}

for (const viewport of [
  { width: 393, height: 650 },
  { width: 402, height: 700 },
  { width: 440, height: 740 },
]) {
  test(`portrait browser controls at ${viewport.width}x${viewport.height} keep all 30 cards reachable with only a short hand scroll`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await denseGame(page, denseSnapshot(30));
    await expect(page.locator(".hand [data-card]")).toHaveCount(30);
    await expect(page.locator(".hand-navigation")).toBeHidden();
    const hand = await page.locator(".hand").evaluate((node) => ({
      overflow: node.scrollHeight - node.clientHeight,
      row: node.firstElementChild!.getBoundingClientRect().height + 10,
    }));
    expect(hand.overflow).toBeLessThanOrEqual(hand.row + 2);
    expect((await visitEveryCard(page)).size).toBe(30);
    await page.screenshot({
      path: `/tmp/uno-portrait-${viewport.width}x${viewport.height}-30.png`,
    });
  });
}

test("portrait safe-area padding keeps 24 and 30 cards and their controls reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 402, height: 874 });
  // Desktop browser engines do not expose an iPhone's safe-area env values.
  // Substitute conservative Dynamic Island/home-indicator insets in the same CSS.
  const safeArea = { top: 62, bottom: 34 };
  for (const count of [24, 30]) {
    const view = denseSnapshot(count);
    if (count === 30)
      Object.assign(view, {
        phase: "finished",
        winner: 1,
        playable: [],
        canCatch: false,
        challenge: false,
        reason: "手牌达到 25 张，本局结束。",
      });
    await denseGame(page, view, safeArea);
    await expect(page.locator(".hand [data-card]")).toHaveCount(count);
    await expect(page.locator(".hand-navigation")).toBeHidden();
    const bounds = await page.evaluate(() => {
      const hand = document.querySelector<HTMLElement>(".hand")!;
      const style = getComputedStyle(document.body);
      const controls = Array.from(
        document.querySelectorAll<HTMLElement>(
          "#pause, #draw, #challenge, #catch, #rematch, .play-controls",
        ),
      ).map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          id: node.id || node.className,
          top: rect.top,
          bottom: rect.bottom,
        };
      });
      return {
        top: style.paddingTop,
        bottom: style.paddingBottom,
        handOverflow: hand.scrollHeight - hand.clientHeight,
        controls,
      };
    });
    expect(bounds.top).toBe("62px");
    expect(bounds.bottom).toBe("34px");
    expect(bounds.handOverflow).toBeLessThanOrEqual(1);
    for (const control of bounds.controls) {
      expect(control.top, control.id).toBeGreaterThanOrEqual(safeArea.top);
      expect(control.bottom, control.id).toBeLessThanOrEqual(
        874 - safeArea.bottom,
      );
    }
    expect((await visitEveryCard(page)).size).toBe(count);
    await assertBoardFits(page);
    await page.screenshot({ path: `/tmp/uno-safe-area-402x874-${count}.png` });
  }
});

test("phone portrait can play the last card directly after a small hand scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const view = denseSnapshot(24);
  const id = view.hand.at(-1)!.id;
  view.playable = [id];
  await denseGame(page, view);
  await expect(page.locator(".hand [data-card]")).toHaveCount(24);
  await expect(page.locator(".hand-navigation")).toBeHidden();
  const card = page.locator(`.hand [data-card="${id}"]`);
  await card.scrollIntoViewIfNeeded();
  await card.click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__viewportCommands
          .filter((command: any) => command.action?.type === "play")
          .map((command: any) => command.action.cardId),
      ),
    )
    .toEqual([id]);
});

test("Safari-style visual viewport changes resize the board while pinch zoom keeps the layout stable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await denseGame(page);
  await page.evaluate(() => {
    Object.defineProperty(visualViewport, "height", {
      configurable: true,
      get: () => 650,
    });
    visualViewport!.dispatchEvent(new Event("resize"));
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.documentElement.style.getPropertyValue(
          "--game-viewport-height",
        ),
      ),
    )
    .toBe("650px");
  await expect(page.locator(".hand [data-card]")).toHaveCount(24);
  const bottom = await page
    .locator(".play-controls")
    .evaluate((node) => node.getBoundingClientRect().bottom);
  expect(bottom).toBeLessThanOrEqual(650);
  await page.evaluate(() => {
    Object.defineProperty(visualViewport, "scale", {
      configurable: true,
      get: () => 2,
    });
    Object.defineProperty(visualViewport, "height", {
      configurable: true,
      get: () => 325,
    });
    visualViewport!.dispatchEvent(new Event("resize"));
  });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  expect(
    await page.evaluate(() =>
      document.documentElement.style.getPropertyValue("--game-viewport-height"),
    ),
  ).toBe("650px");
  await page.evaluate(() => {
    Object.defineProperty(visualViewport, "scale", {
      configurable: true,
      get: () => 1,
    });
    Object.defineProperty(visualViewport, "height", {
      configurable: true,
      get: () => 852,
    });
    visualViewport!.dispatchEvent(new Event("resize"));
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.documentElement.style.getPropertyValue(
          "--game-viewport-height",
        ),
      ),
    )
    .toBe("852px");
  await assertBoardFits(page);
});

test("phone rules keep their close button available while the rules content scrolls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 650 });
  await denseGame(page);
  await page.locator("#pause").click();
  await expect(page.locator("#rules")).toBeVisible();
  const bounds = await page.locator("#rules").evaluate((node) => {
    const r = node.getBoundingClientRect();
    return {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: innerWidth,
      height: innerHeight,
    };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(bounds.width + 1);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height + 1);
  await page.locator("#rules").evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  const closeVisible = await page.locator("#close-rules").evaluate((node) => {
    const r = node.getBoundingClientRect();
    const hit = document.elementFromPoint(
      r.x + r.width / 2,
      r.y + r.height / 2,
    );
    return r.top >= 0 && r.bottom <= innerHeight && !!hit && node.contains(hit);
  });
  expect(closeVisible).toBe(true);
  await page.locator("#close-rules").click();
  await expect(page.locator("#rules")).not.toBeVisible();
  await expect(page.locator("#resume")).toBeVisible();
});

function denseSnapshot(count = 24): View {
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
  const hand: Card[] = Array.from({ length: count }, (_, i) => {
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
async function denseGame(
  page: Page,
  view = denseSnapshot(),
  safeArea?: { top: number; bottom: number },
) {
  const { script, style, html } = await fixtureBundle();
  await page.route("**/viewport-harness", (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
  await page.goto("/viewport-harness");
  await page.addStyleTag({
    content: safeArea
      ? style.replace(
          /env\(safe-area-inset-(top|bottom),\s*0px\)/g,
          (_, edge: "top" | "bottom") => `${safeArea[edge]}px`,
        )
      : style,
  });
  await page.evaluate((view) => {
    (window as any).__viewportFixture = view;
  }, view);
  await page.addScriptTag({ content: script });
  await expect(page.locator(".game")).toBeVisible();
  await settled(page);
}
test("number and action card faces remain visible on either turn after phone rotation and pinch zoom", async ({
  page,
  browserName,
}) => {
  const hand: Card[] = [
    ...[0, 6, 9].map((value): Card => ({
      id: `number-${value}`,
      kind: "number",
      color: "red",
      value,
    })),
    { id: "action-discard", kind: "discardAll", color: "red" },
    { id: "action-reverse", kind: "reverse", color: "green" },
    { id: "action-wild", kind: "wild4", color: null },
    { id: "action-draw", kind: "draw2", color: "green" },
  ];
  const expectedIds = hand.map((card) => card.id).sort();
  for (const turn of [0, 1]) {
    const view = denseSnapshot(hand.length);
    Object.assign(view, {
      hand,
      turn,
      event: null,
      top: { id: "top-zero", kind: "number", color: "blue", value: 0 },
      color: "blue",
      playable: turn === 0 ? ["number-0", "action-wild"] : [],
      penalty: 0,
      lastPenalty: 0,
      challenge: false,
      canCatch: false,
    });
    await page.setViewportSize({ width: 390, height: 720 });
    await denseGame(page, view);
    await expect(page.locator(".hand .card")).toHaveCount(7);
    await expect(page.locator(".hand .card:enabled")).toHaveCount(
      turn === 0 ? 2 : 0,
    );
    expect([...(await visitEveryCard(page))].sort()).toEqual(expectedIds);

    await page.setViewportSize({ width: 720, height: 390 });
    expect([...(await visitEveryCard(page))].sort()).toEqual(expectedIds);

    await page.setViewportSize({ width: 390, height: 720 });
    await expect(page.locator(".hand .card")).toHaveCount(7);
    expect([...(await visitEveryCard(page))].sort()).toEqual(expectedIds);
    if (browserName === "chromium") {
      // Exercise a real visual-viewport scale change, rather than replacing its
      // properties. Layout must stay stable while the browser repaints the SVGs.
      const cdp = await page.context().newCDPSession(page);
      const layout = () =>
        page.locator(".hand .card").evaluateAll((nodes) =>
          nodes.map((node) => ({
            id: node.getAttribute("data-card"),
            card: node.getBoundingClientRect().toJSON(),
            art: node.querySelector(".card-art")!.getBoundingClientRect().toJSON(),
          })),
        );
      const beforeLayout = await layout();
      const before = await page.locator(".hand").screenshot({
        path: `/tmp/uno-card-faces-turn-${turn}-before-zoom.png`,
        animations: "disabled",
      });
      try {
        for (const scale of [1.5, 2, 1]) {
          await cdp.send("Emulation.setPageScaleFactor", {
            pageScaleFactor: scale,
          });
          await expect
            .poll(() => page.evaluate(() => visualViewport!.scale))
            .toBeCloseTo(scale, 2);
          await page.evaluate(
            () =>
              new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              ),
          );
          expect(await layout()).toEqual(beforeLayout);
        }
        await assertBoardFits(page);
        const after = await page.locator(".hand").screenshot({
          path: `/tmp/uno-card-faces-turn-${turn}-after-zoom.png`,
          animations: "disabled",
        });
        const changedPixels = await page.evaluate(async (images) => {
          const [a, b] = await Promise.all(
            images.map(async (encoded) => {
              const image = new Image();
              image.src = `data:image/png;base64,${encoded}`;
              await image.decode();
              const canvas = document.createElement("canvas");
              canvas.width = image.naturalWidth;
              canvas.height = image.naturalHeight;
              const context = canvas.getContext("2d")!;
              context.drawImage(image, 0, 0);
              return context.getImageData(0, 0, canvas.width, canvas.height);
            }),
          );
          if (a.width !== b.width || a.height !== b.height)
            throw new Error("Hand screenshot dimensions changed after zoom");
          let changed = 0;
          for (let i = 0; i < a.data.length; i += 4)
            for (let channel = 0; channel < 4; channel++)
              if (Math.abs(a.data[i + channel] - b.data[i + channel]) > 16) {
                changed++;
                break;
              }
          return changed;
        }, [before.toString("base64"), after.toString("base64")]);
        // A zoom round-trip can slightly change edge antialiasing; a missing or
        // displaced card would alter far more than these few tolerated pixels.
        expect(changedPixels).toBeLessThanOrEqual(20);
      } finally {
        await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
        await cdp.detach();
      }
    }
    await page.screenshot({ path: `/tmp/uno-card-faces-turn-${turn}.png` });
  }
});
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
  await page.setViewportSize({ width: 844, height: 390 });
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
