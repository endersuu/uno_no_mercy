import type { View } from "../shared/types";

export type Cue =
  | "play"
  | "opponent-play"
  | "draw"
  | "deal"
  | "flip"
  | "skip"
  | "discard"
  | "turn"
  | "swap"
  | "uno"
  | "success"
  | "failure"
  | "win"
  | "lose";

/** Short, locally synthesized cues. Returns a stop function for interruptions. */
export function synthesize(
  context: BaseAudioContext,
  output: AudioNode,
  cue: Cue,
): () => void {
  const start = context.currentTime + 0.015;
  const sources = new Set<AudioScheduledSourceNode>();

  function tone(
    frequency: number,
    at: number,
    length: number,
    volume = 0.28,
    type: OscillatorType = "sine",
    endFrequency = frequency,
  ) {
    const source = context.createOscillator();
    const gain = context.createGain();
    sources.add(source);
    source.type = type;
    source.frequency.setValueAtTime(frequency, start + at);
    if (endFrequency !== frequency)
      source.frequency.exponentialRampToValueAtTime(
        endFrequency,
        start + at + length,
      );
    gain.gain.setValueAtTime(0, start + at);
    gain.gain.linearRampToValueAtTime(volume, start + at + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, start + at + length);
    source.connect(gain);
    gain.connect(output);
    source.start(start + at);
    source.stop(start + at + length + 0.01);
    source.onended = () => {
      sources.delete(source);
      source.disconnect();
      gain.disconnect();
    };
  }

  function paper(at: number, length: number, volume = 0.35) {
    const buffer = context.createBuffer(
      1,
      Math.ceil(context.sampleRate * length),
      context.sampleRate,
    );
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const envelope = Math.min(1, i / (context.sampleRate * 0.004));
      data[i] =
        (Math.random() * 2 - 1) * envelope * Math.pow(1 - i / data.length, 1.6);
    }
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    sources.add(source);
    source.buffer = buffer;
    filter.type = "bandpass";
    filter.frequency.value = 1900;
    filter.Q.value = 0.6;
    gain.gain.value = volume;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(output);
    source.start(start + at);
    source.onended = () => {
      sources.delete(source);
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
  }

  if (cue === "play" || cue === "opponent-play") {
    paper(0, 0.17);
    // Rustle while moving, a distinct soft impact when the card lands.
    tone(cue === "play" ? 185 : 150, 0.44, 0.12, 0.42, "triangle", 85);
    tone(cue === "play" ? 1350 : 1050, 0.44, 0.055, 0.16, "triangle");
  } else if (cue === "draw") {
    paper(0, 0.1);
    paper(0.12, 0.1);
    tone(720, 0.2, 0.1, 0.22, "triangle");
  } else if (cue === "deal") {
    for (let i = 0; i < 5; i++) {
      paper(i * 0.085, 0.07, 0.27);
      tone(480 + i * 45, i * 0.085, 0.05, 0.12, "triangle");
    }
  } else if (cue === "flip") {
    paper(0, 0.16, 0.4);
    tone(250, 0.05, 0.17, 0.17, "triangle", 680);
    tone(1046, 0.23, 0.25, 0.24);
  } else if (cue === "skip") {
    // A clear interrupted rhythm, unlike the rising new-turn chime.
    tone(760, 0, 0.085, 0.3, "triangle");
    tone(760, 0.13, 0.085, 0.3, "triangle");
    tone(380, 0.28, 0.2, 0.3, "triangle");
  } else if (cue === "discard") {
    for (let i = 0; i < 4; i++) paper(i * 0.065, 0.09, 0.3);
    tone(220, 0.29, 0.14, 0.32, "triangle", 100);
  } else if (cue === "turn") {
    tone(659, 0, 0.18, 0.3);
    tone(988, 0.15, 0.3, 0.3);
  } else if (cue === "swap") {
    // Two crossing sweeps mirror the two hands moving in opposite directions.
    tone(310, 0, 0.25, 0.24, "triangle", 930);
    tone(930, 0.2, 0.25, 0.24, "triangle", 310);
    paper(0.39, 0.1, 0.25);
  } else if (cue === "uno") {
    tone(784, 0, 0.15, 0.28, "triangle");
    tone(1046, 0.16, 0.25, 0.28, "triangle");
  } else if (cue === "success") {
    tone(523, 0, 0.14);
    tone(659, 0.12, 0.14);
    tone(784, 0.24, 0.23);
  } else if (cue === "failure") {
    tone(330, 0, 0.15, 0.25, "triangle");
    tone(220, 0.15, 0.24, 0.25, "triangle");
  } else if (cue === "win") {
    [523, 659, 784, 1046].forEach((f, i) => tone(f, i * 0.13, 0.32));
  } else if (cue === "lose") {
    tone(392, 0, 0.2, 0.23);
    tone(294, 0.2, 0.3, 0.23);
  }

  return () => {
    for (const source of sources) {
      try {
        source.stop();
      } catch {
        // A source may already have ended between scheduling and cancellation.
      }
    }
    sources.clear();
  };
}

export class GameAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private unlocking: Promise<void> | null = null;
  private pending = new Set<symbol>();
  private active = new Set<() => void>();
  private generation = 0;
  private readonly volume = 0.7;
  enabled = true;

  constructor() {
    try {
      this.enabled = localStorage.getItem("uno-audio") !== "off";
    } catch {}
  }

  get ready() {
    return this.enabled && this.context?.state === "running";
  }

  /** Call directly from a user gesture. Never require audio before sending a move. */
  async unlock(): Promise<void> {
    if (!this.enabled || document.hidden) return;
    if (this.unlocking) return this.unlocking;
    try {
      if (!this.context || this.context.state === "closed") {
        const AudioConstructor =
          window.AudioContext ??
          (window as Window & { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        if (!AudioConstructor) return;
        this.context = new AudioConstructor();
        this.master = this.context.createGain();
        this.master.gain.value = this.enabled ? this.volume : 0;
        this.master.connect(this.context.destination);
      }
      // Safari can report "interrupted" when audio focus was temporarily lost.
      if (this.context.state !== "running") {
        const context = this.context;
        const operation = context.resume().catch(() => {});
        this.unlocking = operation;
        await operation;
        if (this.unlocking === operation) this.unlocking = null;
      }
    } catch {
      this.unlocking = null;
      // Unsupported/blocked audio must never stop the game itself.
    }
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    try {
      localStorage.setItem("uno-audio", enabled ? "on" : "off");
    } catch {}
    if (!enabled) this.cancelPending();
    if (this.master && this.context) {
      this.master.gain.cancelScheduledValues(this.context.currentTime);
      this.master.gain.setValueAtTime(
        enabled ? this.volume : 0,
        this.context.currentTime,
      );
    }
    if (enabled) void this.unlock();
  }

  /** Flush both delayed resume callbacks and currently scheduled cue tails. */
  cancelPending() {
    this.generation++;
    this.pending.clear();
    for (const stop of this.active) stop();
    this.active.clear();
  }

  /** A short test cue makes enabling audio immediately observable to the user. */
  async preview() {
    const generation = this.generation;
    await this.unlock();
    if (generation === this.generation) this.play("turn");
  }

  play(cue: Cue) {
    if (!this.enabled || document.hidden || !this.context || !this.master)
      return;
    const playNow = () => {
      if (!this.ready || document.hidden || !this.context || !this.master)
        return;
      try {
        const stop = synthesize(this.context, this.master, cue);
        this.active.add(stop);
        setTimeout(() => this.active.delete(stop), 1500);
      } catch {}
    };
    if (this.context.state === "running") {
      playNow();
      return;
    }
    // Resume can finish after the server acknowledgement. Keep only fresh cues,
    // not a backlog that would replay after reconnecting or returning to a tab.
    if (this.pending.size >= 3) return;
    const pending = Symbol(cue);
    const generation = this.generation;
    const requestedAt = Date.now();
    this.pending.add(pending);
    void this.unlock().then(() => {
      const valid = this.pending.delete(pending);
      if (
        valid &&
        generation === this.generation &&
        Date.now() - requestedAt < 800
      )
        playNow();
    });
  }

  event(next: View) {
    const event = next.event;
    if (!event) return;
    if (event.action === "play")
      this.play(event.actor === next.me ? "play" : "opponent-play");
    else if (event.action === "draw" || event.action === "roulette")
      this.play("draw");
    else if (event.action === "challenge")
      this.play(event.challengeWon ? "success" : "failure");
    else if (event.action === "uno" || event.action === "catch")
      this.play("uno");
  }

  /** Call when the action-card effect animation begins, after the card lands. */
  effect(next: View) {
    const event = next.event;
    if (!event?.card || next.phase !== "playing") return;
    if (event.swapped) this.play("swap");
    else if (["skip", "reverse", "skipAll"].includes(event.card.kind))
      this.play("skip");
    else if (event.card.kind === "discardAll" && event.discarded > 1)
      this.play("discard");
  }

  /** Call only for a fresh round's initial reveal, never for a restored snapshot. */
  opening() {
    this.play("flip");
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
    // Swap/skip sounds belong to effect(), independent of who gets the next turn.
  }
}

export const gameAudio = new GameAudio();
