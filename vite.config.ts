import { defineConfig } from "vite";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };
let commit = process.env.RENDER_GIT_COMMIT ?? process.env.GITHUB_SHA ?? "";
if (!/^[a-f0-9]{7,64}$/i.test(commit)) {
  try {
    commit = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    commit = "dev";
  }
}
export default defineConfig({
  root: "src/client",
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __BUILD_COMMIT__: JSON.stringify(commit.slice(0, 7)),
  },
  build: { outDir: "../../dist/client", emptyOutDir: true },
  server: { host: "0.0.0.0" },
});
