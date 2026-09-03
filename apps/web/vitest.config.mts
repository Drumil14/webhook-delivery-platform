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
    // Forward the resolved connection string to worker processes.
    env: {
      DATABASE_URL: process.env.DATABASE_URL ?? "",
    },
  },
});
