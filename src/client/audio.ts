import type { View } from "../shared/types";
export type Cue =
  | "play"
  | "draw"
  | "turn"
  | "swap"
  | "uno"
  | "success"
  | "failure"
  | "win"
  | "lose";

/** Small synthesized cues, generated locally; no downloads or background music. */
export function synthesize(
  context: BaseAudioContext,
  output: AudioNode,
  cue: Cue,
) {
  const start = context.currentTime + 0.015;
  function tone(
    frequency: number,
    at: number,
    length: number,
    volume = 0.2,
    type: OscillatorType = "sine",
  ) {
    const source = context.createOscillator(),
      gain = context.createGain();
    source.type = type;
    source.frequency.setValueAtTime(frequency, start + at);
    gain.gain.setValueAtTime(0, start + at);
    gain.gain.linearRampToValueAtTime(volume, start + at + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, start + at + length);
    source.connect(gain);
    gain.connect(output);
    source.start(start + at);
    source.stop(start + at + length + 0.01);
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
    };
  }
  function paper(at: number, length: number) {
    const buffer = context.createBuffer(
      1,
      Math.ceil(context.sampleRate * length),
      context.sampleRate,
    );
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++)
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2);
    const source = context.createBufferSource(),
      filter = context.createBiquadFilter(),
      gain = context.createGain();
    source.buffer = buffer;
    filter.type = "highpass";
    filter.frequency.value = 1500;
    gain.gain.value = 0.18;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(output);
    source.start(start + at);
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
  }
  if (cue === "play") {
    paper(0, 0.13);
    tone(145, 0.32, 0.09, 0.3, "triangle");
  } else if (cue === "draw") {
    paper(0, 0.1);
    paper(0.12, 0.1);
    tone(760, 0.2, 0.07, 0.1);
  } else if (cue === "turn") {
    tone(659, 0, 0.16);
    tone(988, 0.13, 0.28);
  } else if (cue === "swap") {
    tone(350, 0, 0.12, 0.14);
    tone(520, 0.1, 0.12, 0.14);
    tone(700, 0.2, 0.16, 0.14);
  } else if (cue === "uno") {
    tone(784, 0, 0.15, 0.2, "triangle");
    tone(1046, 0.16, 0.25, 0.2, "triangle");
  } else if (cue === "success") {
    tone(523, 0, 0.14);
    tone(659, 0.12, 0.14);
    tone(784, 0.24, 0.23);
  } else if (cue === "failure") {
    tone(330, 0, 0.15, 0.17, "triangle");
    tone(220, 0.15, 0.24, 0.17, "triangle");
  } else if (cue === "win") {
    [523, 659, 784, 1046].forEach((f, i) => tone(f, i * 0.13, 0.32));
  } else if (cue === "lose") {
    tone(392, 0, 0.2, 0.15);
    tone(294, 0.2, 0.3, 0.15);
  }
}
class GameAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  enabled = true;
  constructor() {
    try {
      this.enabled = localStorage.getItem("uno-audio") !== "off";
    } catch {}
  }
  async unlock() {
    if (!this.enabled) return;
    try {
      if (!this.context) {
        this.context = new AudioContext();
        this.master = this.context.createGain();
        this.master.gain.value = 0.38;
        this.master.connect(this.context.destination);
      }
      if (this.context.state === "suspended") await this.context.resume();
    } catch {
      /* Audio support is optional; never block a move. */
    }
  }
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    try {
      localStorage.setItem("uno-audio", enabled ? "on" : "off");
    } catch {}
    if (this.master && this.context) {
      this.master.gain.cancelScheduledValues(this.context.currentTime);
      this.master.gain.setValueAtTime(
        enabled ? 0.38 : 0,
        this.context.currentTime,
      );
    }
    if (enabled) void this.unlock();
  }
  play(cue: Cue) {
    if (
      !this.enabled ||
      document.hidden ||
      this.context?.state !== "running" ||
      !this.master
    )
      return;
    try {
      synthesize(this.context, this.master, cue);
    } catch {}
  }
  event(next: View) {
    const e = next.event;
    if (!e) return;
    if (e.action === "play") this.play("play");
    else if (e.action === "draw" || e.action === "roulette") this.play("draw");
    else if (e.action === "challenge")
      this.play(e.challengeWon ? "success" : "failure");
    else if (e.action === "uno" || e.action === "catch") this.play("uno");
  }
  settled(previous: View | null, next: View) {
    if (next.phase === "finished" && previous?.phase !== "finished") {
      this.play(next.winner === next.me ? "win" : "lose");
      return;
    }
    if (next.phase !== "playing" || next.pausedBy !== null || next.disconnected)
      return;
    if (
      next.turn === next.me &&
      (previous?.phase !== "playing" ||
        previous.turn !== next.me ||
        previous.pausedBy !== null ||
        previous.disconnected ||
        (next.event?.action === "play" && next.event.id !== previous.event?.id))
    )
      this.play("turn");
    else if (next.event?.swapped && next.event.id !== previous?.event?.id)
      this.play("swap");
  }
}
export const gameAudio = new GameAudio();
