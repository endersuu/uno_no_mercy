import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
async function move(page: Page) {
  await expect(page.locator("#app")).toHaveAttribute("data-animating", "false");

  if (
    !(await page.locator(".hand .card:enabled").count()) &&
    (await page.locator("#hand-playable:enabled:visible").count())
  )
    await page.locator("#hand-playable").click();
  if (await page.locator("#roulette:enabled").count()) {
    await page.locator("#roulette").click();
    await page.locator('[data-color="red"]').click();
  } else if (await page.locator(".hand .card:enabled").count()) {
    await page.locator(".hand .card:enabled").first().click();
    if (await page.locator("#colors").isVisible())
      await page.locator('[data-color="blue"]').click();
  } else await page.locator("#draw").click();
  await expect(page.locator("#app")).toHaveAttribute("data-animating", "false");
}
test("turn banner and disabled styles stay clear; real sound cues and persistent mute", async ({
  browser,
}) => {
  const ca = await browser.newContext(),
    cb = await browser.newContext();
  for (const context of [ca, cb])
    await context.addInitScript(() => {
      (window as any).audioStarts = 0;
      for (const prototype of [
        AudioBufferSourceNode.prototype,
        OscillatorNode.prototype,
      ]) {
        const original = prototype.start;
        prototype.start = function (...args: any[]) {
          (window as any).audioStarts++;
          return original.apply(this, args as [number]);
        };
      }
    });
  const a = await ca.newPage(),
    b = await cb.newPage();
  await a.goto("/");
  expect(await a.evaluate(() => (window as any).audioStarts)).toBe(0);
  await a.getByRole("button", { name: "创建房间" }).click();
  await expect(a.locator(".waiting")).toBeVisible();
  await expect(a).toHaveURL(/room=/);
  await b.goto(a.url());
  await b.getByRole("button", { name: "加入房间" }).click();
  await expect(a.locator(".game")).toHaveAttribute("data-turn", "mine");
  await expect(b.locator(".game")).toHaveAttribute("data-turn", "opponent");
  await expect(a.locator(".turn-banner b")).toHaveText("轮到你出牌");
  await expect(b.locator(".turn-banner b")).toContainText("对方回合");
  await expect(b.locator(".hand .card:enabled")).toHaveCount(0);
  await expect(b.locator("#draw")).toBeDisabled();
  const disabled = await b
    .locator(".hand .card")
    .first()
    .evaluate((el) => ({
      opacity: getComputedStyle(el).opacity,
      filter: getComputedStyle(el).filter,
    }));
  expect(Number(disabled.opacity)).toBeLessThan(0.85);
  expect(disabled.filter).toContain("brightness");
  expect(await a.locator(".game .card-art").count()).toBe(8);
  const before = await a.evaluate(() => (window as any).audioStarts);
  await move(a);
  await expect
    .poll(() => a.evaluate(() => (window as any).audioStarts))
    .toBeGreaterThan(before);
  await expect(b.locator("#app")).toHaveAttribute("data-animating", "false");
  const actor =
    (await a.locator(".game").getAttribute("data-turn")) === "mine" ? a : b;
  await actor.locator("#toggle-sound").click();
  await expect(actor.locator("#toggle-sound")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  const mutedCount = await actor.evaluate(() => (window as any).audioStarts);
  await move(actor);
  expect(await actor.evaluate(() => (window as any).audioStarts)).toBe(
    mutedCount,
  );
  await actor.reload();
  await expect(actor.locator("#toggle-sound")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(await actor.evaluate(() => (window as any).audioStarts)).toBe(0);
  await a.screenshot({ path: "/tmp/uno-v030-table.png", fullPage: true });
  await ca.close();
  await cb.close();
});
test("all synthesized cues render finite, audible waveforms without clipping", async ({
  page,
}) => {
  const result = await build({
    entryPoints: ["src/client/audio.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "UnoAudio",
    platform: "browser",
  });
  await page.goto("/");
  await page.addScriptTag({ content: result.outputFiles[0].text });
  const values = await page.evaluate(async () => {
    const result = [];
    for (const cue of [
      "play",
      "opponent-play",
      "draw",
      "deal",
      "flip",
      "skip",
      "discard",
      "turn",
      "swap",
      "uno",
      "success",
      "failure",
      "win",
      "lose",
    ]) {
      const context = new OfflineAudioContext(1, 44100, 44100);
      (window as any).UnoAudio.synthesize(context, context.destination, cue);
      const buffer = await context.startRendering(),
        samples = buffer.getChannelData(0);
      let peak = 0,
        energy = 0;
      for (const x of samples) {
        peak = Math.max(peak, Math.abs(x));
        energy += x * x;
      }
      result.push({ cue, peak, energy });
    }
    return result;
  });
  for (const value of values) {
    expect(value.peak, value.cue).toBeGreaterThan(0.01);
    expect(value.peak, value.cue).toBeLessThan(1);
    expect(value.energy, value.cue).toBeGreaterThan(1);
  }
});
test("mobile game has visible turn cue, sound control and no overflow", async ({
  browser,
}) => {
  const ca = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    }),
    cb = await browser.newContext();
  const a = await ca.newPage(),
    b = await cb.newPage();
  await a.goto("/");
  await a.getByRole("button", { name: "创建房间" }).click();
  await expect(a.locator(".waiting")).toBeVisible();
  await expect(a).toHaveURL(/room=/);
  await b.goto(a.url());
  await b.getByRole("button", { name: "加入房间" }).click();
  await expect(a.locator(".turn-banner")).toBeVisible();
  await expect(a.locator("#toggle-sound")).toBeVisible();
  expect(
    await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await a.evaluate(async () => {
    await Promise.all(
      document.getAnimations().map((a) => a.finished.catch(() => {})),
    );
  });
  await a.screenshot({ path: "/tmp/uno-v030-mobile.png", fullPage: true });
  await a.locator(".hand-heading").scrollIntoViewIfNeeded();
  await expect(a.locator(".hand-turn-tag")).toHaveText("轮到你");
  await ca.close();
  await cb.close();
});
