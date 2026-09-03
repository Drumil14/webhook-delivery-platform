import { existsSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { defineConfig } from "vitest/config";

// Load the repo-root .env (single source of truth) so tests run against the same
// PostgreSQL database the apps use. Optional: if DATABASE_URL is already
// injected, this is skipped.
const rootEnv = resolve(process.cwd(), "../../.env");
if (!process.env.DATABASE_URL && existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(process.cwd()),
    },
  },
  test: {
    environment: "node",
    // Test files share one real database and ONE pg-boss queue. Run files
    // sequentially so a queue `fetch()` in one file can't grab another file's
    // job. (Tests within a file already run sequentially.)
    fileParallelism: false,
    // These are real integration tests against remote Neon (many round-trips per
    // test: ingest + fetch + finalize transactions + queue ops). The default 5s
    // is too tight under network latency, so raise it. (Retry delays themselves
    // are already tiny via injected test policies — this is purely network time.)
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Forward the resolved connection string to worker processes.
    env: {
      DATABASE_URL: process.env.DATABASE_URL ?? "",
    },
  },
});
