import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const events = new Set([
  "visitor_connected",
  "room_entered",
  "player_active",
  "visitor_disconnected",
]);
const scopes = ["persistent", "ephemeral", "connection"] as const;
interface RecordData {
  kind: "uno-analytics";
  schemaVersion: 1;
  at: string;
  event: string;
  run_id: string;
  connection_id: string;
  device_id: string;
  identity_scope: (typeof scopes)[number];
  browser: string;
  os: string;
  device_type: string;
  language: string | null;
  timezone: string | null;
  source: string | null;
  referrer: string | null;
  room_id?: string;
  round_id?: string;
}

function bounded(value: unknown, max = 128): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function valid(value: unknown): value is RecordData {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    r.kind === "uno-analytics" &&
    r.schemaVersion === 1 &&
    typeof r.at === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.at) &&
    Number.isFinite(Date.parse(r.at)) &&
    new Date(r.at).toISOString() === r.at &&
    typeof r.event === "string" &&
    events.has(r.event) &&
    bounded(r.run_id) &&
    bounded(r.connection_id) &&
    typeof r.device_id === "string" &&
    /^[a-f0-9]{64}$/.test(r.device_id) &&
    scopes.includes(r.identity_scope as (typeof scopes)[number]) &&
    bounded(r.browser) &&
    bounded(r.os) &&
    ["desktop", "mobile", "tablet", "unknown"].includes(
      r.device_type as string,
    ) &&
    (r.source === null || bounded(r.source, 80)) &&
    (r.referrer === null || bounded(r.referrer, 253)) &&
    (r.language === null || bounded(r.language, 64)) &&
    (r.timezone === null || bounded(r.timezone, 80)) &&
    (r.room_id === undefined || bounded(r.room_id)) &&
    (r.round_id === undefined || bounded(r.round_id)) &&
    (r.event !== "room_entered" || bounded(r.room_id)) &&
    (r.event !== "player_active" || (bounded(r.room_id) && bounded(r.round_id)))
  );
}

function audience() {
  return { visitors: new Set<string>(), players: new Set<string>() };
}
type Audience = ReturnType<typeof audience>;
function add(a: Audience, r: RecordData) {
  // Any valid event proves a visit, including partial log exports that start
  // after the connection was established.
  a.visitors.add(r.device_id);
  if (r.event === "player_active") a.players.add(r.device_id);
}
function counts(a: Audience) {
  return { visitors: a.visitors.size, players: a.players.size };
}
function group(map: Map<string, Audience>, key: string, r: RecordData) {
  let a = map.get(key);
  if (!a) map.set(key, (a = audience()));
  add(a, r);
}
function breakdown<K extends string>(map: Map<string, Audience>, label: K) {
  return [...map]
    .sort(
      (a, b) =>
        b[1].visitors.size - a[1].visitors.size || a[0].localeCompare(b[0]),
    )
    .map(
      ([key, a]) =>
        ({ [label]: key, ...counts(a) }) as Record<K, string> &
          ReturnType<typeof counts>,
    );
}

/** Streaming accumulator: retains unique keys, never entire event records. */
export class AnalyticsReport {
  private all = audience();
  private connections = new Set<string>();
  private entrants = new Set<string>();
  private rounds = new Set<string>();
  private days = new Map<string, Audience>();
  private sources = new Map<string, Audience>();
  private browsers = new Map<string, Audience>();
  private systems = new Map<string, Audience>();
  private deviceTypes = new Map<string, Audience>();
  private languages = new Map<string, Audience>();
  private timezones = new Map<string, Audience>();
  private identities = new Map<string, Audience>();
  private first: string | null = null;
  private last: string | null = null;
  private accepted = 0;
  private malformed = 0;
  private ignored = 0;

  consume(line: string) {
    const start = line.indexOf("{");
    if (start < 0) {
      this.ignored++;
      return;
    }
    let value: unknown;
    try {
      // Render and other hosts can prepend a timestamp or service label.
      value = JSON.parse(line.slice(start));
    } catch {
      if (line.includes('"uno-analytics"')) this.malformed++;
      else this.ignored++;
      return;
    }
    if (
      !value ||
      typeof value !== "object" ||
      (value as Record<string, unknown>).kind !== "uno-analytics"
    ) {
      this.ignored++;
      return;
    }
    if (!valid(value)) {
      this.malformed++;
      return;
    }
    const r = value;
    this.accepted++;
    this.first = this.first === null || r.at < this.first ? r.at : this.first;
    this.last = this.last === null || r.at > this.last ? r.at : this.last;
    add(this.all, r);
    this.connections.add(JSON.stringify([r.run_id, r.connection_id]));
    if (r.event === "room_entered") this.entrants.add(r.device_id);
    if (r.event === "player_active")
      this.rounds.add(JSON.stringify([r.run_id, r.room_id, r.round_id]));
    group(this.days, r.at.slice(0, 10), r);
    group(
      this.sources,
      r.source
        ? `utm:${r.source}`
        : r.referrer
          ? `referrer:${r.referrer}`
          : "direct/unknown",
      r,
    );
    group(this.browsers, r.browser, r);
    group(this.systems, r.os, r);
    group(this.deviceTypes, r.device_type, r);
    group(this.languages, r.language ?? "unknown", r);
    group(this.timezones, r.timezone ?? "unknown", r);
    group(this.identities, r.identity_scope, r);
  }

  result() {
    return {
      kind: "uno-analytics-report",
      schemaVersion: 1,
      timezone: "UTC",
      range: { first: this.first, last: this.last },
      input: {
        accepted_records: this.accepted,
        malformed_records: this.malformed,
        ignored_lines: this.ignored,
      },
      totals: {
        ...counts(this.all),
        room_entrants: this.entrants.size,
        connections: this.connections.size,
        rounds: this.rounds.size,
      },
      daily: [...this.days]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, a]) => ({ date, ...counts(a) })),
      by_source: breakdown(this.sources, "source"),
      by_browser: breakdown(this.browsers, "browser"),
      by_os: breakdown(this.systems, "os"),
      by_device_type: breakdown(this.deviceTypes, "device_type"),
      by_language: breakdown(this.languages, "language"),
      by_timezone: breakdown(this.timezones, "timezone"),
      by_identity_scope: breakdown(this.identities, "identity_scope"),
    };
  }
}

async function main() {
  const files = process.argv.slice(2);
  if (files.includes("--help") || files.includes("-h")) {
    console.log(
      "Usage: npm run analytics:report -- [log-file ...]\nNo files: read JSONL logs from stdin. Output: aggregated JSON (UTC).",
    );
    return;
  }
  const report = new AnalyticsReport();
  for (const file of files.length ? files : ["-"]) {
    const input = file === "-" ? process.stdin : createReadStream(file, "utf8");
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) report.consume(line);
    } finally {
      lines.close();
      if (input !== process.stdin) input.destroy();
    }
  }
  console.log(JSON.stringify(report.result(), null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Failed to read analytics logs.",
    );
    process.exitCode = 1;
  });
}
