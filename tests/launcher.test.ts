import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

interface Invocation {
  tool: "node" | "mise";
  cwd: string;
  args: string[];
}

function launch(options: {
  version?: string;
  mise?: boolean;
  miseStatus?: number;
}) {
  const root = mkdtempSync(join(tmpdir(), "uno launcher "));
  const project = join(root, "game with spaces"),
    bin = join(root, "fake tools");
  const log = join(root, "calls.jsonl");
  mkdirSync(project);
  mkdirSync(bin);
  copyFileSync(
    new URL("../start-local.sh", import.meta.url),
    join(project, "start-local.sh"),
  );
  // Keep PATH isolated so a developer's own Node or mise cannot satisfy a missing-tool case.
  writeFileSync(
    join(bin, "dirname"),
    '#!/bin/sh\np=$1\nprintf "%s\\n" "${p%/*}"\n',
    { mode: 0o755 },
  );
  function tool(name: Invocation["tool"], body: string) {
    writeFileSync(
      join(bin, name),
      `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.UNO_TEST_CALLS, JSON.stringify({ tool: ${JSON.stringify(name)}, cwd: process.cwd(), args }) + "\\n");
${body}
`,
      { mode: 0o755 },
    );
  }
  if (options.version) {
    tool(
      "node",
      `if (args[0] === "-e") {
  Object.defineProperty(process.versions, "node", { value: process.env.UNO_TEST_NODE_VERSION });
  require("node:vm").runInThisContext(args[1]);
}`,
    );
  }
  if (options.mise)
    tool(
      "mise",
      "process.exit(Number(process.env.UNO_TEST_MISE_STATUS || 0));",
    );
  try {
    const result = spawnSync("/bin/sh", [join(project, "start-local.sh")], {
      cwd: root,
      env: {
        ...process.env,
        PATH: bin,
        UNO_TEST_CALLS: log,
        UNO_TEST_NODE_VERSION: options.version ?? "",
        UNO_TEST_MISE_STATUS: String(options.miseStatus ?? 0),
      },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(
      result.error,
      undefined,
      "launcher must finish without hanging or recursively re-entering",
    );
    const calls: Invocation[] = existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      calls,
      project,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const posix = { skip: process.platform === "win32" };
for (const version of ["22.12.0", "24.22.1"]) {
  test(
    `launcher uses supported Node ${version} without invoking mise`,
    posix,
    () => {
      const result = launch({ version, mise: true });
      assert.equal(result.status, 0, result.output);
      assert.equal(
        result.calls.filter((call) => call.tool === "mise").length,
        0,
      );
      const launches = result.calls.filter(
        (call) => call.tool === "node" && call.args[0] !== "-e",
      );
      assert.deepEqual(launches, [
        {
          tool: "node",
          cwd: result.project,
          args: ["scripts/start-local.mjs"],
        },
      ]);
    },
  );
}
for (const version of ["20.19.0", "22.11.0", undefined]) {
  test(
    `launcher delegates ${version ? `old Node ${version}` : "missing Node"} to mise once`,
    posix,
    () => {
      const result = launch({ version, mise: true });
      assert.equal(result.status, 0, result.output);
      assert.deepEqual(
        result.calls.filter((call) => call.tool === "mise"),
        [
          {
            tool: "mise",
            cwd: result.project,
            args: ["exec", "node@24", "--", "node", "scripts/start-local.mjs"],
          },
        ],
      );
      assert.equal(
        result.calls.filter(
          (call) => call.tool === "node" && call.args[0] !== "-e",
        ).length,
        0,
      );
    },
  );
}
test(
  "mise failure stops with an error instead of retrying the obsolete Node",
  posix,
  () => {
    const result = launch({ version: "20.19.0", mise: true, miseStatus: 17 });
    assert.notEqual(result.status, 0);
    assert.equal(result.calls.filter((call) => call.tool === "mise").length, 1);
    assert.equal(
      result.calls.filter(
        (call) => call.tool === "node" && call.args[0] !== "-e",
      ).length,
      0,
    );
  },
);
for (const version of ["22.11.0", undefined]) {
  test(
    `launcher gives recovery instructions for ${version ? "old" : "missing"} Node without mise`,
    posix,
    () => {
      const result = launch({ version });
      assert.notEqual(result.status, 0);
      assert.match(result.output, /22\.12/);
      assert.match(result.output, /mise/);
      assert.match(result.output, /node@24|Node\.js 24/);
      assert.equal(
        result.calls.filter((call) => call.args[0] !== "-e").length,
        0,
      );
    },
  );
}
