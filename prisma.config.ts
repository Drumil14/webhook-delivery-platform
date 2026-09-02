import { existsSync } from "node:fs";
import process from "node:process";

import { defineConfig } from "prisma/config";

// Prisma 7 no longer reads `url` from schema.prisma and does not auto-load .env.
// The CLI is run from the repo root, so load the root .env if it exists (local
// dev). When DATABASE_URL is already injected (e.g. running migrations in a
// deploy pipeline with no file), this is skipped.
if (!process.env.DATABASE_URL && existsSync(".env")) {
  process.loadEnvFile(".env");
}

export default defineConfig({
  schema: "packages/db/prisma/schema.prisma",
  migrations: {
    path: "packages/db/prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
