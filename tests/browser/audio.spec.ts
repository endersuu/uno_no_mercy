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

test("a new gesture retries a stuck resume, including interruptions and sound preview", async ({
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
    let context: FakeContext;
    class FakeContext {
      state = "suspended";
      currentTime = 0;
      destination = {};
      allowResume = false;
      resumeCalls = 0;
      started = 0;
      constructor() {
        context = this;
      }
      resume() {
        this.resumeCalls++;
        // Model a browser that leaves a request made before activation pending.
        // It must not prevent a later request inside a valid tap from succeeding.
        if (!this.allowResume) return new Promise<void>(() => {});
        this.state = "running";
        return Promise.resolve();
      }
      createGain() {
        return { connect() {}, disconnect() {}, gain: param() };
      }
      createOscillator() {
        return {
          connect() {},
          disconnect() {},
          frequency: param(),
          start: () => this.started++,
          stop() {},
        };
      }
    }
    (window as any).AudioContext = FakeContext;
    const newAudio = () => {
      localStorage.removeItem("uno-audio");
      return new (window as any).AudioUnderTest.GameAudio();
    };
    const settles = (operation: Promise<void>) =>
      Promise.race([
        operation.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 500),
        ),
      ]);

    const audio = newAudio();
    void audio.unlock();
    void audio.unlock();
    const backgroundCalls = context!.resumeCalls;
    const initiallyReady = audio.ready;
    context!.allowResume = true;
    const gestureSettled = await settles(audio.unlock(true));
    audio.play("turn");
    const gesture = {
      ready: audio.ready,
      calls: context!.resumeCalls,
      starts: context!.started,
    };

    context!.state = "interrupted";
    context!.allowResume = false;
    void audio.unlock();
    void audio.unlock();
    const interruptedBackgroundCalls = context!.resumeCalls;
    context!.allowResume = true;
    const interruptedSettled = await settles(audio.unlock(true));
    audio.play("turn");
    const interrupted = {
      ready: audio.ready,
      calls: context!.resumeCalls,
      starts: context!.started,
    };

    context!.state = "interrupted";
    context!.allowResume = false;
    void audio.unlock();
    audio.setEnabled(false);
    const callsBeforeMuteGesture = context!.resumeCalls;
    const mutedSettled = await settles(audio.unlock(true));
    audio.play("turn");
    const muted = {
      ready: audio.ready,
      calls: context!.resumeCalls,
      starts: context!.started,
    };

    const previewAudio = newAudio();
    void previewAudio.unlock();
    context!.allowResume = true;
    const previewSettled = await settles(previewAudio.preview());
    return {
      backgroundCalls,
      initiallyReady,
      gestureSettled,
      gesture,
      interruptedBackgroundCalls,
      interruptedSettled,
      interrupted,
      callsBeforeMuteGesture,
      mutedSettled,
      muted,
      previewSettled,
      previewReady: previewAudio.ready,
      previewCalls: context!.resumeCalls,
      previewStarts: context!.started,
    };
  });
  expect(result.backgroundCalls).toBe(1);
  expect(result.initiallyReady).toBe(false);
  expect(result.gestureSettled).toBe(true);
  expect(result.gesture.ready).toBe(true);
  expect(result.gesture.calls).toBe(2);
  expect(result.gesture.starts).toBeGreaterThan(0);
  expect(result.interruptedBackgroundCalls).toBe(3);
  expect(result.interruptedSettled).toBe(true);
  expect(result.interrupted.ready).toBe(true);
  expect(result.interrupted.calls).toBe(4);
  expect(result.interrupted.starts).toBeGreaterThan(result.gesture.starts);
  expect(result.mutedSettled).toBe(true);
  expect(result.muted.ready).toBe(false);
  expect(result.muted.calls).toBe(result.callsBeforeMuteGesture);
  expect(result.muted.starts).toBe(result.interrupted.starts);
  expect(result.previewSettled).toBe(true);
  expect(result.previewReady).toBe(true);
  expect(result.previewCalls).toBe(2);
  expect(result.previewStarts).toBeGreaterThan(0);
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
