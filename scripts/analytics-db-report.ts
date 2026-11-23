import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Client, InStatement, Row } from "@libsql/client";
import {
  createAnalyticsClient,
  DATABASE_TIMEOUT_MS,
  type AnalyticsDbClient,
} from "../src/server/turso.js";

export interface DateRange {
  from?: string;
  to?: string;
}

function validDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value
  );
}

function validateRange(range: DateRange) {
  if (
    (range.from !== undefined && !validDate(range.from)) ||
    (range.to !== undefined && !validDate(range.to))
  )
    throw Error("日期需为有效的 YYYY-MM-DD（UTC）。");
  if (range.from && range.to && range.from > range.to)
    throw Error("--from 不能晚于 --to。");
}

export function parseDateRange(args: string[]): DateRange {
  const range: DateRange = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (flag !== "--from" && flag !== "--to")
      throw Error("仅支持 --from YYYY-MM-DD 和 --to YYYY-MM-DD。");
    const key = flag === "--from" ? "from" : "to";
    if (range[key] !== undefined || !validDate(args[i + 1]))
      throw Error("日期参数不能重复，且需为有效的 YYYY-MM-DD（UTC）。");
    range[key] = args[i + 1];
  }
  validateRange(range);
  return range;
}

const countsSql = `COUNT(DISTINCT device_id) AS visitors,
  COUNT(DISTINCT CASE WHEN played = 1 THEN device_id END) AS players,
  COUNT(DISTINCT CASE WHEN room_entered = 1 THEN device_id END) AS room_entrants`;

function counts(row: Row) {
  return {
    visitors: Number(row.visitors),
    players: Number(row.players),
    room_entrants: Number(row.room_entrants),
  };
}

// These expressions are application constants. User arguments are bound values.
const dimensions = [
  [
    "by_source",
    "source",
    `CASE WHEN source IS NOT NULL AND source != ''
    THEN 'utm:' || source
    WHEN referrer IS NOT NULL AND referrer != '' THEN 'referrer:' || referrer
    ELSE 'direct/unknown' END`,
  ],
  ["by_browser", "browser", "browser"],
  ["by_os", "os", "os"],
  ["by_device_type", "device_type", "device_type"],
  ["by_language", "language", "COALESCE(language, 'unknown')"],
  ["by_timezone", "timezone", "COALESCE(timezone, 'unknown')"],
  ["by_identity_scope", "identity_scope", "identity_scope"],
] as const;
type DimensionReports = {
  [D in (typeof dimensions)[number] as D[0]]: (Record<D[1], string> &
    ReturnType<typeof counts>)[];
};

/** Queries existing tables only; a read-only database token is sufficient. */
export async function readAnalyticsDatabase(
  client: Pick<Client, "batch">,
  range: DateRange = {},
) {
  validateRange(range);
  const predicates: string[] = [];
  const args: string[] = [];
  if (range.from) {
    predicates.push("day >= ?");
    args.push(range.from);
  }
  if (range.to) {
    predicates.push("day <= ?");
    args.push(range.to);
  }
  const where = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
  const query = (sql: string): InStatement => ({ sql, args });
  // One read transaction keeps totals and all breakdowns consistent while the
  // game server continues to record new activity.
  const results = await client.batch(
    [
      query(`SELECT ${countsSql}, MIN(first_seen) AS first_seen,
      MAX(last_seen) AS last_seen FROM analytics_daily ${where}`),
      query(`SELECT day, ${countsSql} FROM analytics_daily ${where}
      GROUP BY day ORDER BY day`),
      ...dimensions.map(([, , expression]) =>
        query(`SELECT ${expression} AS dimension, ${countsSql}
        FROM analytics_daily ${where}
        GROUP BY ${expression} ORDER BY visitors DESC, dimension ASC`),
      ),
    ],
    "read",
  );
  const total = results[0].rows[0];
  const groups = Object.fromEntries(
    dimensions.map(([key, label], i) => [
      key,
      results[i + 2].rows.map((row) => ({
        [label]: String(row.dimension),
        ...counts(row),
      })),
    ]),
  ) as DimensionReports;
  return {
    kind: "uno-analytics-db-report",
    schemaVersion: 1,
    timezone: "UTC",
    range: {
      from: range.from ?? null,
      to: range.to ?? null,
      first: total.first_seen,
      last: total.last_seen,
    },
    totals: counts(total),
    daily: results[1].rows.map((row) => ({ date: row.day, ...counts(row) })),
    ...groups,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(
      "Usage: npm run analytics:db-report -- [--from YYYY-MM-DD] [--to YYYY-MM-DD]\n" +
        "UTC dates, inclusive. Reads TURSO_DATABASE_URL and TURSO_AUTH_TOKEN. Does not create or update tables.",
    );
    return;
  }
  let range: DateRange;
  try {
    range = parseDateRange(args);
  } catch (error) {
    // Parser errors contain fixed messages, never credentials or arguments.
    console.error((error as Error).message);
    process.exitCode = 1;
    return;
  }
  let client: AnalyticsDbClient | null = null;
  try {
    client = createAnalyticsClient({ required: true });
    if (!client) throw Error("Missing analytics database configuration.");
    console.log(
      JSON.stringify(await readAnalyticsDatabase(client, range), null, 2),
    );
  } catch {
    // SDK/network errors can contain database URLs. Do not echo them.
    console.error(
      "无法读取统计数据库。请检查 TURSO_DATABASE_URL / TURSO_AUTH_TOKEN、网络连接及服务器是否已成功初始化统计表。",
    );
    process.exitCode = 1;
  } finally {
    // Some native SDK versions do not apply query deadlines to session close.
    // Results are already printed; a stalled cleanup must not hang this CLI.
    setTimeout(
      () => process.exit(process.exitCode ?? 0),
      DATABASE_TIMEOUT_MS + 1000,
    ).unref();
    try {
      client?.close();
    } catch {
      /* Cleanup must not expose driver details. */
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
