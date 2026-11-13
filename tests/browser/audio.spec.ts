import { test, expect } from "@playwright/test";
import { build } from "esbuild";

let audioBundle = "";
test.beforeAll(async () => {
  const result = await build({
    entryPoints: ["src/client/audio.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "AudioUnderTest",
    platform: "browser",
  });
  audioBundle = result.outputFiles[0].text;
});

test.beforeEach(async ({ page }) => {
  // Isolate the audio module from live rooms, Socket.IO and autoplay side effects.
  await page.route("**/audio-harness", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body>Audio regression harness</body></html>",
    }),
  );
  await page.goto("/audio-harness");
  await page.addScriptTag({ content: audioBundle });
});

test("self play, opponent play, skip, swap and opening flip have distinct sound signatures", async ({
  page,
}) => {
  const differences = await page.evaluate(async () => {
    const cues = ["play", "opponent-play", "skip", "swap", "flip"];
    const recordings: Float32Array[] = [];
    for (const cue of cues) {
      const context = new OfflineAudioContext(1, 44100, 44100);
      const random = Math.random;
      let seed = 12345;
      // Identical paper noise for every cue prevents random noise alone from
      // making otherwise identical sounds pass the distinctness assertion.
      Math.random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      try {
        (window as any).AudioUnderTest.synthesize(
          context,
          context.destination,
          cue,
        );
      } finally {
        Math.random = random;
      }
      recordings.push((await context.startRendering()).getChannelData(0));
    }
    const result: { pair: string; difference: number }[] = [];
    for (let a = 0; a < recordings.length; a++) {
      for (let b = a + 1; b < recordings.length; b++) {
        let distance = 0;
        let energy = 0;
        for (let i = 0; i < recordings[a].length; i++) {
          const left = recordings[a][i];
          const right = recordings[b][i];
          distance += (left - right) ** 2;
          energy += left ** 2 + right ** 2;
        }
        result.push({
          pair: `${cues[a]} / ${cues[b]}`,
          difference: distance / energy,
        });
      }
    }
    return result;
  });
  for (const result of differences) {
    expect(Number.isFinite(result.difference), result.pair).toBe(true);
    expect(result.difference, result.pair).toBeGreaterThan(0.05);
  }
});

test("audio resume keeps a fresh cue, while mute, cancellation and expiration discard pending cues", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const param = () => ({
      value: 0,
      setValueAtTime() {},
      linearRampToValueAtTime() {},
      exponentialRampToValueAtTime() {},
      cancelScheduledValues() {},
    });
    const contexts: FakeContext[] = [];
    class FakeContext {
      state = "suspended";
      currentTime = 0;
      sampleRate = 44100;
      destination = {};
      started = 0;
      stopped = 0;
      resumeCalls = 0;
      resolveResume: (() => void) | null = null;
      constructor() {
        contexts.push(this);
      }
      resume() {
        this.resumeCalls++;
        return new Promise<void>((resolve) => {
          this.resolveResume = () => {
            this.state = "running";
            resolve();
          };
        });
      }
      node() {
        return { connect() {}, disconnect() {} };
      }
      createGain() {
        return { ...this.node(), gain: param() };
      }
      createOscillator() {
        return { ...this.node(), frequency: param(), ...this.source() };
      }
      createBuffer(_channels: number, size: number) {
        return { getChannelData: () => new Float32Array(size) };
      }
      createBufferSource() {
        return { ...this.node(), ...this.source() };
      }
      createBiquadFilter() {
        return { ...this.node(), frequency: param(), Q: param() };
      }
      source() {
        return {
          start: () => this.started++,
          stop: () => this.stopped++,
        };
      }
    }
    (window as any).AudioContext = FakeContext;
    const newAudio = () => {
      localStorage.removeItem("uno-audio");
      return new (window as any).AudioUnderTest.GameAudio();
    };
    const settleMicrotasks = async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    };

    const fresh = newAudio();
    const freshUnlock = fresh.unlock();
    fresh.play("play");
    const freshContext = contexts.at(-1)!;
    const beforeResume = freshContext.started;
    freshContext.resolveResume!();
    await freshUnlock;
    await settleMicrotasks();
    const freshStarts = freshContext.started;
    const stopsBeforeCancellation = freshContext.stopped;
    fresh.cancelPending();

    const muted = newAudio();
    const mutedUnlock = muted.unlock();
    muted.play("flip");
    const mutedContext = contexts.at(-1)!;
    muted.setEnabled(false);
    mutedContext.resolveResume!();
    await mutedUnlock;
    await settleMicrotasks();
    const restored = new (window as any).AudioUnderTest.GameAudio();

    const cancelled = newAudio();
    const cancelledUnlock = cancelled.unlock();
    cancelled.play("swap");
    const cancelledContext = contexts.at(-1)!;
    cancelled.cancelPending();
    cancelledContext.resolveResume!();
    await cancelledUnlock;
    await settleMicrotasks();

    const expired = newAudio();
    const now = Date.now;
    let clock = 1000;
    Date.now = () => clock;
    let expiredContext: FakeContext;
    try {
      const expiredUnlock = expired.unlock();
      expired.play("skip");
      expiredContext = contexts.at(-1)!;
      clock += 900;
      expiredContext.resolveResume!();
      await expiredUnlock;
      await settleMicrotasks();
    } finally {
      Date.now = now;
    }
    return {
      beforeResume,
      freshStarts,
      freshResumeCalls: freshContext.resumeCalls,
      freshReady: fresh.ready,
      cancelledSources: freshContext.stopped - stopsBeforeCancellation,
      mutedStarts: mutedContext.started,
      cancelledStarts: cancelledContext.started,
      expiredStarts: expiredContext!.started,
      mutePersisted: !restored.enabled,
    };
  });
  expect(result.beforeResume).toBe(0);
  expect(result.freshStarts).toBeGreaterThan(0);
  expect(result.freshResumeCalls).toBe(1);
  expect(result.freshReady).toBe(true);
  expect(result.cancelledSources).toBeGreaterThan(0);
  expect(result.mutedStarts).toBe(0);
  expect(result.cancelledStarts).toBe(0);
  expect(result.expiredStarts).toBe(0);
  expect(result.mutePersisted).toBe(true);
});

test("public card events route skip and swap independently from turn feedback, and opening is explicit", async ({
  page,
}) => {
  const result = await page.evaluate(() => {
    const audio = new (window as any).AudioUnderTest.GameAudio();
    const cues: string[] = [];
    audio.play = (cue: string) => cues.push(cue);
    const previous = {
      me: 0,
      phase: "playing",
      turn: 1,
      pausedBy: null,
      disconnected: false,
      event: { id: 1 },
    };
    const next = {
      ...previous,
      turn: 0,
      event: {
        id: 2,
        actor: 1,
        action: "play",
        card: { kind: "number", value: 7 },
        swapped: true,
        discarded: 0,
      },
    };
    audio.event(next);
    audio.effect(next);
    audio.settled(previous, next);
    const swapped = cues.splice(0);
    const skip = {
      ...next,
      event: {
        ...next.event,
        actor: 0,
        swapped: false,
        card: { kind: "skip" },
      },
    };
    audio.event(skip);
    audio.effect(skip);
    audio.settled(previous, skip);
    const skipped = cues.splice(0);
    audio.effect({ ...skip, phase: "finished" });
    const finishedEffects = cues.splice(0);
    audio.opening();
    const opening = cues.splice(0);
    audio.settled(next, next);
    const unchangedSnapshot = cues.splice(0);
    return { swapped, skipped, finishedEffects, opening, unchangedSnapshot };
  });
  expect(result.swapped).toEqual(["opponent-play", "swap", "turn"]);
  expect(result.skipped).toEqual(["play", "skip", "turn"]);
  expect(result.finishedEffects).toEqual([]);
  expect(result.opening).toEqual(["flip"]);
  expect(result.unchangedSnapshot).toEqual([]);
});
