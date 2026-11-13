import { test, expect, type Page } from "@playwright/test";

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

test("phone viewport resize preserves deal and card landing sounds while pause cancels them", async ({
  browser,
}) => {
  const ca = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const cb = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  for (const context of [ca, cb])
    await context.addInitScript(() => {
      const w = window as any;
      const probe = (w.audioProbe = {
        sources: [] as {
          ended: boolean;
          cancelled: boolean;
          oscillator: boolean;
          delay: number;
        }[],
        resizeCount: 0,
        resizeArmed: false,
        pauseArmed: false,
      });
      const ids = new WeakMap<AudioScheduledSourceNode, number>();
      for (const prototype of [
        AudioBufferSourceNode.prototype,
        OscillatorNode.prototype,
      ]) {
        const start = prototype.start;
        const stop = prototype.stop;
        prototype.start = function (...args: any[]) {
          const entry = {
            ended: false,
            cancelled: false,
            oscillator: this instanceof OscillatorNode,
            delay: (args[0] ?? 0) - this.context.currentTime,
          };
          ids.set(this, probe.sources.push(entry) - 1);
          this.addEventListener(
            "ended",
            () => {
              entry.ended = true;
            },
            { once: true },
          );
          const result = start.apply(this, args as [number]);
          if (probe.resizeArmed) {
            probe.resizeArmed = false;
            // The keyboard/address bar closes immediately after a room enters
            // the table. Dispatch during audio, before the 440ms landing cue.
            requestAnimationFrame(() => {
              const height = visualViewport!.height === 700 ? 760 : 700;
              Object.defineProperty(visualViewport, "height", {
                configurable: true,
                get: () => height,
              });
              visualViewport!.dispatchEvent(new Event("resize"));
              probe.resizeCount++;
            });
          }
          if (probe.pauseArmed) {
            probe.pauseArmed = false;
            requestAnimationFrame(() =>
              document.getElementById("pause")!.click(),
            );
          }
          return result;
        };
        prototype.stop = function (...args: any[]) {
          const id = ids.get(this);
          if (
            id !== undefined &&
            (args[0] === undefined || args[0] <= this.context.currentTime)
          )
            probe.sources[id].cancelled = true;
          return stop.apply(this, args as [number]);
        };
      }
    });
  const a = await ca.newPage(),
    b = await cb.newPage();
  const settled = async () => {
    for (const page of [a, b])
      await expect(page.locator("#app")).toHaveAttribute(
        "data-animating",
        "false",
      );
  };
  const playableSeat = async (): Promise<Page> => {
    for (let attempt = 0; attempt < 12; attempt++) {
      await settled();
      const actor =
        (await a.locator(".game").getAttribute("data-turn")) === "mine" ? a : b;
      if (await actor.locator(".hand .card:enabled").count()) return actor;
      if (await actor.locator("#roulette:enabled").count()) {
        await actor.locator("#roulette").tap();
        await actor.locator('[data-color="blue"]').tap();
      } else await actor.locator("#draw:enabled").tap();
    }
    throw new Error("No playable card after resolving pending draws");
  };
  const play = async (actor: Page) => {
    await actor.locator(".hand .card:enabled").first().tap();
    if (await actor.locator("#colors").isVisible())
      await actor.locator('[data-color="blue"]').tap();
  };
  try {
    await a.goto("/");
    await a.getByRole("button", { name: "创建房间" }).tap();
    await expect(a.locator(".waiting")).toBeVisible();
    await expect(a).toHaveURL(/room=/);
    await b.goto(a.url());
    for (const page of [a, b])
      await page.evaluate(() => {
        (window as any).audioProbe.resizeArmed = true;
      });
    await b.getByRole("button", { name: "加入房间" }).tap();
    for (const page of [a, b]) {
      await expect
        .poll(() => page.evaluate(() => (window as any).audioProbe.resizeCount))
        .toBe(1);
      await settled();
      const sources = await page.evaluate(
        () => (window as any).audioProbe.sources,
      );
      expect(
        sources.length,
        "the real opening must schedule audio",
      ).toBeGreaterThan(0);
      expect(
        sources.filter((source: any) => source.cancelled),
        "layout resize must not cancel the opening sound",
      ).toEqual([]);
      await expect
        .poll(() =>
          page.evaluate(() =>
            (window as any).audioProbe.sources.every(
              (source: any) => source.ended,
            ),
          ),
        )
        .toBe(true);
    }

    const actor = await playableSeat();
    const marker = await actor.evaluate(() => {
      const p = (window as any).audioProbe;
      p.resizeArmed = true;
      return { source: p.sources.length, resize: p.resizeCount };
    });
    await play(actor);
    await expect
      .poll(() => actor.evaluate(() => (window as any).audioProbe.resizeCount))
      .toBe(marker.resize + 1);
    await settled();
    const played = await actor.evaluate(
      (from) => (window as any).audioProbe.sources.slice(from),
      marker.source,
    );
    expect(
      played.some((source: any) => source.oscillator && source.delay > 0.4),
      "a card landing tone must be scheduled beyond the resize",
    ).toBe(true);
    expect(
      played.filter((source: any) => source.cancelled),
      "layout resize must not cut off the landing tone",
    ).toEqual([]);
    await expect
      .poll(() =>
        actor.evaluate(
          (from) =>
            (window as any).audioProbe.sources
              .slice(from)
              .every((source: any) => source.ended),
          marker.source,
        ),
      )
      .toBe(true);

    const pausing = await playableSeat();
    const pauseMarker = await pausing.evaluate(() => {
      const p = (window as any).audioProbe;
      p.pauseArmed = true;
      return p.sources.length;
    });
    await play(pausing);
    await expect(pausing.locator("#rules")).toBeVisible();
    await expect
      .poll(
        () =>
          pausing.evaluate(
            (from) =>
              (window as any).audioProbe.sources
                .slice(from)
                .some((source: any) => source.cancelled),
            pauseMarker,
          ),
        { message: "a real pause must still stop current cue tails" },
      )
      .toBe(true);
  } finally {
    await ca.close();
    await cb.close();
  }
});
