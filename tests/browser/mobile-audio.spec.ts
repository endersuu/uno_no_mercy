import { test, expect } from "@playwright/test";

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

test("touch release unlocks sound and the sound button recovers interrupted audio", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = window as any;
    const NativeAudioContext = window.AudioContext;
    let gesture = "";
    w.audioResumes = [];
    w.audioStarts = 0;
    w.audioContexts = 0;
    // Model Safari's release-only permission, including resume calls that stay
    // pending when made too early. Use real Web Audio nodes for the preview.
    for (const type of [
      "pointerdown",
      "pointerup",
      "touchend",
      "click",
      "keydown",
    ])
      document.addEventListener(
        type,
        () => {
          gesture = type;
          setTimeout(() => {
            gesture = "";
          }, 0);
        },
        { capture: true },
      );
    class TouchAudioContext extends NativeAudioContext {
      blocked: AudioContextState | null = "suspended";
      constructor() {
        super();
        w.audioContexts++;
        w.interruptSound = () => {
          this.blocked = "interrupted" as AudioContextState;
        };
      }
      get state() {
        return this.blocked ?? super.state;
      }
      resume() {
        w.audioResumes.push(gesture);
        if (!["pointerup", "touchend", "click", "keydown"].includes(gesture))
          return new Promise<void>(() => {});
        this.blocked = null;
        return super.resume();
      }
    }
    w.AudioContext = TouchAudioContext;
    for (const prototype of [
      AudioBufferSourceNode.prototype,
      OscillatorNode.prototype,
    ]) {
      const start = prototype.start;
      prototype.start = function (...args: any[]) {
        w.audioStarts++;
        return start.apply(this, args as [number]);
      };
    }
  });
  await page.goto("/");
  const sound = page.locator("#toggle-sound");
  await expect(sound).toHaveText("♪ 点此启用声音");
  expect(await page.evaluate(() => (window as any).audioContexts)).toBe(0);

  // A normal tap on the page must unlock audio before entering the game.
  await page.locator("#name").tap();
  await expect(sound).toHaveText("♪ 音效 开");
  const resumes = await page.evaluate(
    () => (window as any).audioResumes as string[],
  );
  expect(resumes.length).toBeGreaterThan(0);
  expect(resumes).not.toContain("pointerdown");

  // A return from a call/control centre can interrupt an existing context.
  await page.evaluate(() => {
    (window as any).interruptSound();
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(sound).toHaveText("♪ 点此启用声音");
  await sound.tap();
  await expect(sound).toHaveText("♪ 音效 开");
  await expect(sound).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() => page.evaluate(() => (window as any).audioStarts))
    .toBeGreaterThan(0);

  await sound.tap();
  await expect(sound).toHaveText("♪ 音效 关");
  const muted = await page.evaluate(() => ({
    starts: (window as any).audioStarts,
    resumes: (window as any).audioResumes.length,
  }));
  await page.locator("#name").tap();
  expect(
    await page.evaluate(() => ({
      starts: (window as any).audioStarts,
      resumes: (window as any).audioResumes.length,
    })),
  ).toEqual(muted);
  await sound.tap();
  await expect(sound).toHaveText("♪ 音效 开");
  await expect
    .poll(() => page.evaluate(() => (window as any).audioStarts))
    .toBeGreaterThan(muted.starts);
});
