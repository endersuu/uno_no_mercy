import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Card,
  DebugEntry,
  DebugRoundSummary,
  DebugSnapshot,
  DebugState,
} from "../shared/types.js";

type Header = Pick<
  DebugSnapshot,
  "room" | "players" | "initialDeck" | "initialDeckTop" | "server"
>;
interface StoredRound {
  summary: DebugRoundSummary;
  path: string | null;
  // Constant-sized recovery data per round; the full history lives on disk.
  header: Header;
  first: DebugEntry;
  latest: DebugState;
  recordingError?: string;
}

/** Private, room-scoped files; never served by Express or sent in normal Views. */
export class DebugRecords {
  private directory: string | null = null;
  private rooms = new Map<string, Map<string, StoredRound>>();
  constructor(
    private root = tmpdir(),
    private appendLine: (path: string, line: string) => void = appendFileSync,
  ) {}

  start(
    room: string,
    round: number,
    initialDeck: Card[],
    state: DebugState,
    at: string,
  ) {
    const header: Header = {
      room,
      players: state.players.map((p) => p.name),
      initialDeck,
      initialDeckTop: "last",
      server: {
        appVersion: process.env.npm_package_version ?? "0.8.1",
        commit: process.env.RENDER_GIT_COMMIT ?? null,
        rulesVersion: "no-mercy-house-stack-challenge-v1",
      },
    };
    const first: DebugEntry = {
      sequence: 1,
      at,
      actor: null,
      kind: "start",
      accepted: true,
      before: null,
      after: state,
    };
    const record: StoredRound = {
      summary: {
        roundId: state.game.roundId,
        round,
        startedAt: at,
        finishedAt: null,
        entryCount: 1,
        complete: true,
      },
      path: null,
      header: structuredClone(header),
      first: structuredClone(first),
      latest: structuredClone(state),
    };
    let rounds = this.rooms.get(room);
    if (!rounds) this.rooms.set(room, (rounds = new Map()));
    rounds.set(state.game.roundId, record);
    try {
      this.directory ??= mkdtempSync(join(this.root, "uno-debug-"));
      record.path = join(this.directory, `${state.game.roundId}.jsonl`);
      writeFileSync(
        record.path,
        `${JSON.stringify(header)}\n${JSON.stringify(first)}\n`,
        { mode: 0o600, flag: "wx" },
      );
    } catch {
      record.path = null;
      this.fail(record, "无法建立完整调试记录文件；本局记录不完整。");
    }
  }

  append(room: string, roundId: string, entry: Omit<DebugEntry, "sequence">) {
    const record = this.rooms.get(room)?.get(roundId);
    if (!record) return;
    const next: DebugEntry = {
      ...entry,
      sequence: ++record.summary.entryCount,
    };
    record.latest = structuredClone(entry.after);
    if (entry.after.game.winner !== null)
      record.summary.finishedAt ??= entry.at;
    // After an I/O failure, do not append after a possibly partial JSON line.
    if (!record.summary.complete || !record.path) {
      return;
    }
    try {
      this.appendLine(record.path, `${JSON.stringify(next)}\n`);
    } catch {
      this.fail(
        record,
        "调试记录写入失败；此前记录仍可导出，但本局记录不完整。",
      );
    }
  }

  summaries(room: string): DebugRoundSummary[] {
    return [...(this.rooms.get(room)?.values() ?? [])].map((r) => ({
      ...r.summary,
    }));
  }

  export(
    room: string,
    roundId: string,
    exportedAt: string,
    current?: DebugState,
  ): DebugSnapshot {
    const record = this.rooms.get(room)?.get(roundId);
    if (!record) throw Error("找不到这局的调试记录，请选择当前房间内的对局。");
    const entries: DebugEntry[] = [];
    if (record.path) {
      try {
        const lines = readFileSync(record.path, "utf8").trimEnd().split("\n");
        const parsedHeader = JSON.parse(lines.shift()!);
        if (
          parsedHeader?.room !== room ||
          !Array.isArray(parsedHeader?.initialDeck) ||
          JSON.stringify(parsedHeader) !== JSON.stringify(record.header)
        )
          throw Error("invalid recording header");
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line) as DebugEntry;
            if (
              parsed?.sequence !== entries.length + 1 ||
              parsed?.after?.game?.roundId !== roundId ||
              (parsed.before && parsed.before.game?.roundId !== roundId)
            )
              throw Error("invalid recording sequence");
            entries.push(parsed);
          } catch {
            this.fail(record, "调试记录文件不完整；已导出可读取的部分。");
            break;
          }
        }
      } catch {
        this.fail(record, "无法读取调试记录文件；本局记录不完整。");
      }
    }
    if (!entries.length) entries.push(record.first);
    if (entries.length !== record.summary.entryCount)
      this.fail(record, "调试记录条数与操作次数不一致；本局记录不完整。");
    const snapshot: DebugSnapshot = {
      schemaVersion: 1,
      kind: "uno-debug-snapshot",
      exportedAt,
      ...record.header,
      round: { ...record.summary },
      entries,
      current: current ?? record.latest,
      complete: record.summary.complete,
      ...(record.recordingError
        ? { recordingError: record.recordingError }
        : {}),
    };
    return structuredClone(snapshot);
  }

  deleteRoom(room: string) {
    const rounds = this.rooms.get(room);
    this.rooms.delete(room);
    for (const record of rounds?.values() ?? []) {
      if (record.path)
        try {
          rmSync(record.path, { force: true });
        } catch {}
    }
    if (!this.rooms.size && this.directory) {
      try {
        rmSync(this.directory, { recursive: true, force: true });
      } catch {}
      this.directory = null;
    }
  }

  private fail(record: StoredRound, message: string) {
    record.summary.complete = false;
    record.recordingError ??= message;
  }
}
