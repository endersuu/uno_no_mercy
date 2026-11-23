import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAnalyticsClient,
  databaseFetch,
  DATABASE_TIMEOUT_MS,
} from "../src/server/turso.js";

const token = "fixture-private-token";
const invalidConfiguration =
  "Invalid Turso configuration. Use the cloud database URL and its database token; production requires a remote database.";

test("database configuration is optional unless explicitly required", () => {
  assert.equal(createAnalyticsClient({ env: {} }), null);
  assert.equal(
    createAnalyticsClient({
      env: { TURSO_DATABASE_URL: " ", TURSO_AUTH_TOKEN: "\t" },
    }),
    null,
  );
  assert.throws(() => createAnalyticsClient({ required: true, env: {} }), {
    message: "TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required.",
  });
});

test("partial credentials and unsafe database URLs fail with a fixed, secret-free error", () => {
  const environments = [
    { TURSO_AUTH_TOKEN: token },
    { TURSO_DATABASE_URL: "libsql://private-db.example" },
    ...[
      "not-a-url-private-secret",
      "http://private-db.example",
      "ws://private-db.example",
      "wss://private-db.example",
      "https://private-user:private-password@private-db.example",
      "libsql://private-user@private-db.example",
      "https://private-db.example/private-path",
      "turso://private-db.example?private-query=secret",
      "libsql://private-db.example#private-fragment",
      "https:///",
    ].map((TURSO_DATABASE_URL) => ({
      TURSO_DATABASE_URL,
      TURSO_AUTH_TOKEN: token,
    })),
  ];
  for (const env of environments)
    assert.throws(() => createAnalyticsClient({ env }), {
      message: invalidConfiguration,
    });
});

test("production and Render refuse local databases, including with a supplied token", () => {
  for (const env of [
    { NODE_ENV: "production" },
    { NODE_ENV: "development", RENDER: "true" },
    { TURSO_AUTH_TOKEN: token },
  ])
    assert.throws(
      () =>
        createAnalyticsClient({
          env: { ...env, TURSO_DATABASE_URL: "file::memory:" },
        }),
      { message: invalidConfiguration },
    );
});

test("development file databases use real libSQL execute and atomic batch operations", async () => {
  const db = createAnalyticsClient({
    env: { TURSO_DATABASE_URL: "file::memory:", NODE_ENV: "test" },
  });
  assert.ok(db);
  try {
    await db.execute(
      "CREATE TABLE visits (device TEXT PRIMARY KEY, plays INTEGER)",
    );
    await db.execute("INSERT INTO visits VALUES (?, ?)", ["browser-1", 1]);
    await db.batch([
      { sql: "UPDATE visits SET plays = plays + ?", args: [2] },
      { sql: "INSERT INTO visits VALUES (?, ?)", args: ["browser-2", 4] },
    ]);
    const result = await db.execute("SELECT SUM(plays) AS total FROM visits");
    assert.equal(result.rows[0].total, 7);
    await assert.rejects(
      db.batch([
        "UPDATE visits SET plays = 99",
        "INSERT INTO missing_table VALUES (1)",
      ]),
    );
    const unchanged = await db.execute(
      "SELECT SUM(plays) AS total FROM visits",
    );
    assert.equal(unchanged.rows[0].total, 7);
  } finally {
    db.close();
  }
});

// Every global fetch mock below is scoped to an awaited, sequential subtest.
test("remote database transports enforce their configuration and preserve the SQL adapter contract", async (t) => {
  await t.test(
    "databaseFetch combines caller cancellation with its deadline and rejects redirects",
    async () => {
      const originalFetch = globalThis.fetch;
      const originalTimeout = AbortSignal.timeout;
      const deadline = new AbortController();
      const caller = new AbortController();
      const observed: RequestInit[] = [];
      const deadlines: number[] = [];
      AbortSignal.timeout = (milliseconds) => {
        deadlines.push(milliseconds);
        return deadline.signal;
      };
      globalThis.fetch = async (_input, init) => {
        observed.push(init!);
        return new Response("ok");
      };
      try {
        await databaseFetch("https://database.example", {
          signal: caller.signal,
          redirect: "follow",
        });
        assert.equal(observed[0].redirect, "error");
        assert.equal(observed[0].signal!.aborted, false);
        caller.abort();
        assert.equal(observed[0].signal!.aborted, true);

        const requestCaller = new AbortController();
        await databaseFetch(
          new Request("https://database.example", {
            signal: requestCaller.signal,
          }),
        );
        requestCaller.abort();
        assert.equal(observed[1].signal!.aborted, true);

        await databaseFetch("https://database.example");
        deadline.abort(new DOMException("deadline", "TimeoutError"));
        assert.equal(observed[2].signal!.aborted, true);
        assert.equal(observed[2].signal!.reason.name, "TimeoutError");
        assert.deepEqual(deadlines, Array(3).fill(DATABASE_TIMEOUT_MS));
      } finally {
        globalThis.fetch = originalFetch;
        AbortSignal.timeout = originalTimeout;
      }
    },
  );

  await t.test(
    "libsql URLs use only abortable HTTPS requests even with uppercase schemes",
    async () => {
      const originalFetch = globalThis.fetch;
      const requests: Request[] = [];
      globalThis.fetch = async (input, init) => {
        requests.push(new Request(input, init));
        throw new TypeError("fixture transport unavailable");
      };
      try {
        for (const scheme of ["libsql", "LIBSQL", "https"]) {
          const db = createAnalyticsClient({
            env: {
              TURSO_DATABASE_URL: `${scheme}://database.example/`,
              TURSO_AUTH_TOKEN: token,
            },
          });
          assert.ok(db);
          try {
            await assert.rejects(db.execute("SELECT 1"));
          } finally {
            db.close();
          }
        }
        assert.ok(requests.length >= 3);
        assert.ok(
          requests.every((request) => request.url.startsWith("https://")),
        );
        assert.ok(requests.every((request) => request.redirect === "error"));
        assert.ok(
          requests.every((request) => request.signal instanceof AbortSignal),
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );

  await t.test(
    "native Turso executes positional/named statements and read/write batches",
    async () => {
      const originalFetch = globalThis.fetch;
      const originalTimeout = AbortSignal.timeout;
      const deadlines: number[] = [];
      AbortSignal.timeout = (milliseconds) => {
        deadlines.push(milliseconds);
        return originalTimeout(milliseconds);
      };
      const requests: {
        url: string;
        signal: AbortSignal | null | undefined;
        steps: {
          stmt: { sql: string; args: unknown[]; named_args: unknown[] };
        }[];
      }[] = [];
      globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        assert.equal(request.headers.get("authorization"), `Bearer ${token}`);
        const body = JSON.parse(await request.text());
        const steps = body.requests[0].batch.steps;
        requests.push({ url: request.url, signal: init?.signal, steps });
        return Response.json({
          baton: null,
          results: [
            {
              type: "ok",
              response: {
                type: "batch",
                result: {
                  step_results: steps.map(() => ({
                    cols: [{ name: "total", decltype: "INTEGER" }],
                    rows: [[{ type: "integer", value: "7" }]],
                    affected_row_count: 0,
                  })),
                  step_errors: steps.map(() => null),
                },
              },
            },
            {
              type: "ok",
              response: { type: "get_autocommit", is_autocommit: true },
            },
          ],
        });
      };
      try {
        for (const scheme of ["turso", "TURSO"]) {
          const db = createAnalyticsClient({
            env: {
              TURSO_DATABASE_URL: `${scheme}://database.example/`,
              TURSO_AUTH_TOKEN: token,
            },
          });
          assert.ok(db);
          try {
            const result = await db.execute("SELECT ? AS total", [7]);
            assert.deepEqual(result.columns, ["total"]);
            assert.equal(result.rows[0].total, 7);
            await db.execute({ sql: "SELECT :n AS total", args: { n: 7 } });
            const batch = await db.batch([
              "SELECT 7 AS total",
              ["SELECT ? AS total", [7]],
            ]);
            assert.equal(batch.length, 2);
            assert.equal(batch[1].rows[0].total, 7);
            await db.batch(["SELECT 7 AS total"], "read");
          } finally {
            db.close();
          }
        }
        assert.equal(requests.length, 8);
        assert.ok(
          requests.every(
            (request) => request.url === "https://database.example/v3/pipeline",
          ),
        );
        assert.ok(
          requests.every((request) => request.signal instanceof AbortSignal),
        );
        assert.deepEqual(requests[0].steps[0].stmt.args, [
          { type: "integer", value: "7" },
        ]);
        assert.deepEqual(requests[1].steps[0].stmt.named_args, [
          { name: "n", value: { type: "integer", value: "7" } },
        ]);
        assert.equal(requests[2].steps[0].stmt.sql, "BEGIN IMMEDIATE");
        assert.deepEqual(requests[2].steps[2].stmt.args, [
          { type: "integer", value: "7" },
        ]);
        assert.equal(requests[3].steps[0].stmt.sql, "BEGIN DEFERRED");
        assert.deepEqual(deadlines, Array(8).fill(DATABASE_TIMEOUT_MS));
      } finally {
        globalThis.fetch = originalFetch;
        AbortSignal.timeout = originalTimeout;
      }
    },
  );
});
