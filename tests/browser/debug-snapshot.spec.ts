import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { io } from "socket.io-client";
import type { DebugSnapshot, DebugState, Reply } from "../../src/shared/types";
import { playable } from "../../src/server/game";

async function settled(page: Page) {
  await expect(page.locator("#app")).toHaveAttribute("data-animating", "false");
}

async function exportSnapshot(page: Page) {
  await settled(page);
  const activity = page.locator(".activity");
  if (!(await activity.evaluate((node) => (node as HTMLDetailsElement).open)))
    await activity.locator("summary").click();
  await expect(page.locator("#export-debug")).toBeEnabled();
  const revision = await page.locator("#app").getAttribute("data-revision");
  const turn = await page.locator(".game").getAttribute("data-turn");
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#export-debug").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.json$/);
  expect(await download.failure()).toBeNull();
  const file = await download.path();
  expect(file).toBeTruthy();
  const snapshot: DebugSnapshot = JSON.parse(await readFile(file!, "utf8"));
  await expect(page.locator("#app")).toHaveAttribute(
    "data-revision",
    revision!,
  );
  await expect(page.locator(".game")).toHaveAttribute("data-turn", turn!);
  expect(snapshot.current.revision).toBe(Number(revision));
  return snapshot;
}

function cardIds(state: DebugState) {
  const game = state.game;
  return [...game.hands.flat(), ...game.deck, ...game.discard].map((c) => c.id);
}

test("mobile debug export downloads the full round, keeps actions beyond the visible log, and survives rejoining", async ({
  browser,
  baseURL,
}) => {
  const ca = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
  });
  const cb = await browser.newContext({ reducedMotion: "reduce" });
  const a = await ca.newPage(),
    b = await cb.newPage();
  const errors: string[] = [];
  for (const page of [a, b])
    page.on("pageerror", (error) => errors.push(error.message));
  try {
    await a.goto("/");
    await a.locator("#name").fill("Alice");
    await a.getByRole("button", { name: "创建房间" }).click();
    await expect(a).toHaveURL(/room=/);
    await b.goto(a.url());
    await b.locator("#name").fill("Bob");
    await b.getByRole("button", { name: "加入房间" }).click();
    for (const page of [a, b]) {
      await expect(page.locator(".hand .card")).toHaveCount(7);
      await settled(page);
    }

    const room = new URL(a.url()).searchParams.get("room")!;
    const tokens = await Promise.all(
      [a, b].map((page) =>
        page.evaluate(
          (room) => sessionStorage.getItem(`uno-token-${room}`),
          room,
        ),
      ),
    );
    const initial = await exportSnapshot(a);
    expect(initial.schemaVersion).toBe(1);
    expect(initial.kind).toBe("uno-debug-snapshot");
    expect(initial.complete).toBe(true);
    expect(initial.room).toBe(room);
    expect(initial.players).toEqual(["Alice", "Bob"]);
    expect(initial.initialDeck).toHaveLength(168);
    expect(initial.initialDeckTop).toBe("last");
    expect(initial.current.game.hands.map((hand) => hand.length)).toEqual([
      7, 7,
    ]);
    const unseated = io(baseURL!, {
      transports: ["websocket"],
      reconnection: false,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        unseated.once("connect", resolve);
        unseated.once("connect_error", reject);
      });
      const denied: Reply = await unseated
        .timeout(10_000)
        .emitWithAck("command", {
          type: "debug-export",
          roundId: initial.round.roundId,
        });
      expect(denied.ok).toBe(false);
      expect("snapshot" in denied).toBe(false);
    } finally {
      unseated.close();
    }
    const start = initial.entries.find((entry) => entry.kind === "start")!;
    expect(start).toBeTruthy();
    expect(start.before).toBeNull();
    const drawOrder = [...initial.initialDeck].reverse();
    for (let i = 0; i < 7; i++) {
      expect(start.after.game.hands[0][i].id).toBe(drawOrder[2 * i].id);
      expect(start.after.game.hands[1][i].id).toBe(drawOrder[2 * i + 1].id);
    }
    for (const [seat, page] of [a, b].entries()) {
      expect(
        await page
          .locator(".hand [data-card]")
          .evaluateAll((cards) =>
            cards.map((card) => card.getAttribute("data-card")),
          ),
      ).toEqual(initial.current.game.hands[seat].map((card) => card.id));
    }
    await expect(a.locator("#debug-round")).toHaveValue(initial.round.roundId);
    // Both controls stay inside the expanded activity panel on a phone.
    for (const id of ["debug-round", "export-debug"]) {
      const box = await a.locator(`#${id}`).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(391);
      expect(box!.y + box!.height).toBeLessThanOrEqual(845);
    }
    await a.screenshot({ path: "/tmp/uno-debug-export-390.png" });
    await a.locator(".activity summary").click();

    // Include a genuine accepted play and its selected color, when applicable.
    // Only draw when the recorded deck guarantees a playable card before Mercy.
    // The export test should not depend on a lucky random deal avoiding game end.
    if (
      !(await a.locator(".hand [data-card]:enabled").count()) &&
      initial.current.game.deck
        .slice(-17)
        .some((card) => playable(initial.current.game, card))
    ) {
      const before = await a.locator("#app").getAttribute("data-revision");
      await a.locator("#draw").click();
      await expect(a.locator("#app")).not.toHaveAttribute(
        "data-revision",
        before!,
      );
      await settled(a);
    }
    let playedId: string | null = null,
      chosenColor = false;
    const cardsById = new Map(
      initial.initialDeck.map((card) => [card.id, card]),
    );
    const heldIds = await a
      .locator(".hand [data-card]")
      .evaluateAll((cards) =>
        cards.map((card) => card.getAttribute("data-card")!),
      );
    const playableIds = await a
      .locator(".hand [data-card]:enabled")
      .evaluateAll((cards) =>
        cards.map((card) => card.getAttribute("data-card")!),
      );
    // Avoid finishing the round before exercising pause/resume recording.
    const continuingPlay = playableIds.find((id) => {
      const card = cardsById.get(id)!;
      return (
        card.kind !== "discardAll" ||
        heldIds.some((held) => cardsById.get(held)!.color !== card.color)
      );
    });
    if (continuingPlay) {
      const before = await a.locator("#app").getAttribute("data-revision");
      const played = a.locator(`.hand [data-card="${continuingPlay}"]`);
      playedId = continuingPlay;
      await played.click();
      chosenColor = await a.locator("#colors").isVisible();
      if (chosenColor) await a.locator('[data-color="blue"]').click();
      await expect(a.locator("#app")).not.toHaveAttribute(
        "data-revision",
        before!,
      );
      await settled(a);
    }

    // Fourteen room actions must all be exported, regardless of the 12-line UI log.
    for (let i = 0; i < 7; i++) {
      await a.locator("#pause").click();
      await expect(a.locator("#rules")).toBeVisible();
      await a.locator("#rules-done").click();
      await a.locator("#resume").click();
      await expect(a.locator(".pause-banner")).toHaveCount(0);
    }

    const beforeReload = await a.locator("#app").getAttribute("data-revision");
    const guestHand = await b
      .locator(".hand [data-card]")
      .evaluateAll((cards) =>
        cards.map((card) => card.getAttribute("data-card")),
      );
    await b.reload();
    await expect(b.locator(".hand .card")).toHaveCount(guestHand.length);
    await settled(b);
    await expect(a.locator("#app")).not.toHaveAttribute(
      "data-revision",
      beforeReload!,
    );
    await expect(a.locator("#app")).toHaveAttribute(
      "data-revision",
      (await b.locator("#app").getAttribute("data-revision"))!,
    );
    expect(
      await b
        .locator(".hand [data-card]")
        .evaluateAll((cards) =>
          cards.map((card) => card.getAttribute("data-card")),
        ),
    ).toEqual(guestHand);

    const snapshot = await exportSnapshot(a);
    expect(snapshot.round.roundId).toBe(initial.round.roundId);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.entries.length).toBeGreaterThan(14);
    expect(snapshot.entries[0]).toEqual(initial.entries[0]);
    const actions = snapshot.entries.filter((entry) => entry.kind === "action");
    const pauses = actions.filter((entry) => entry.action?.type === "pause");
    const resumes = actions.filter((entry) => entry.action?.type === "resume");
    expect(pauses).toHaveLength(7);
    expect(resumes).toHaveLength(7);
    for (const pause of pauses) {
      expect(pause.accepted).toBe(true);
      expect(pause.before?.pausedBy).toBeNull();
      expect(pause.after.pausedBy).toBe(0);
    }
    for (const resume of resumes) {
      expect(resume.accepted).toBe(true);
      expect(resume.before?.pausedBy).toBe(0);
      expect(resume.after.pausedBy).toBeNull();
    }
    if (playedId) {
      const play = actions.find((entry) => entry.action?.type === "play")!;
      expect(play.accepted).toBe(true);
      expect(play.action?.type === "play" && play.action.cardId).toBe(playedId);
      expect(play.after.game.discard.at(-1)?.id).toBe(playedId);
      if (chosenColor) {
        expect(play.action?.type === "play" && play.action.color).toBe("blue");
        expect(play.after.game.color).toBe("blue");
      }
    }
    expect(snapshot.entries.some((entry) => entry.kind === "disconnect")).toBe(
      true,
    );
    expect(snapshot.entries.some((entry) => entry.kind === "reconnect")).toBe(
      true,
    );
    for (const entry of snapshot.entries) {
      expect(cardIds(entry.after)).toHaveLength(168);
      expect(new Set(cardIds(entry.after)).size).toBe(168);
    }
    const json = JSON.stringify(snapshot);
    for (const token of tokens) {
      expect(token).toBeTruthy();
      expect(json.includes(token!)).toBe(false);
    }
    expect(json.includes('"token":')).toBe(false);
    expect(json.includes('"socket":')).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await Promise.all([ca.close(), cb.close()]);
  }
});
