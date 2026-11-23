import {
  createClient,
  type Client,
  type InArgs,
  type InStatement,
} from "@libsql/client";
import { connect } from "@tursodatabase/serverless";

export type AnalyticsDbClient = Pick<Client, "execute" | "batch" | "close">;
export const DATABASE_TIMEOUT_MS = 5000;

/** Abort real HTTP work, rather than leaving timed-out requests running behind retries. */
export const databaseFetch: typeof fetch = (input, init) => {
  const signals = [AbortSignal.timeout(DATABASE_TIMEOUT_MS)];
  const original =
    init?.signal ?? (input instanceof Request ? input.signal : null);
  if (original) signals.push(original);
  return fetch(input, {
    ...init,
    signal: AbortSignal.any(signals),
    redirect: "error",
  });
};

export function createAnalyticsClient({
  required = false,
  env = process.env,
}: {
  required?: boolean;
  env?: NodeJS.ProcessEnv;
} = {}): AnalyticsDbClient | null {
  const databaseUrl = env.TURSO_DATABASE_URL?.trim();
  const authToken = env.TURSO_AUTH_TOKEN?.trim();
  if (!databaseUrl && !authToken) {
    if (required)
      throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required.");
    return null;
  }
  try {
    if (!databaseUrl) throw new Error();
    const url = new URL(databaseUrl);
    if (url.protocol === "file:") {
      // Never silently write a production database onto Render's ephemeral disk.
      if (env.NODE_ENV === "production" || env.RENDER === "true" || authToken)
        throw new Error();
      return createClient({ url: databaseUrl });
    }
    if (
      !authToken ||
      !["libsql:", "https:", "turso:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname && url.pathname !== "/")
    )
      throw new Error();
    if (url.protocol === "turso:") {
      const connection = connect({
        url: url.href,
        authToken,
        defaultQueryTimeout: DATABASE_TIMEOUT_MS,
      });
      // Native Turso and libSQL have separate official drivers. Keep the tiny
      // SQL surface used by analytics identical for either cloud database type.
      return {
        async execute(statement: InStatement, args?: InArgs) {
          const stmt =
            typeof statement === "string" && args
              ? { sql: statement, args }
              : statement;
          return (await connection.batch([stmt]))[0];
        },
        async batch(statements, mode = "write") {
          return connection.batch(
            statements.map((stmt) =>
              Array.isArray(stmt) ? { sql: stmt[0], args: stmt[1] } : stmt,
            ),
            mode === "read" ? "deferred" : mode,
          );
        },
        close() {
          void connection.close().catch(() => {});
        },
      };
    }
    // libsql:// is explicitly mapped to HTTPS so all requests use the abortable
    // fetch transport instead of a persistent WebSocket connection.
    const httpsUrl = url.href.replace(/^libsql:/i, "https:");
    return createClient({
      url: httpsUrl,
      authToken,
      fetch: databaseFetch,
      concurrency: 1,
    });
  } catch {
    // Driver errors can embed credentials or URLs. Expose only a fixed message.
    throw new Error(
      "Invalid Turso configuration. Use the cloud database URL and its database token; production requires a remote database.",
    );
  }
}
