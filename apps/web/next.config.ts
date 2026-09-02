import { existsSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import type { NextConfig } from "next";

// Local-dev convenience: load the repo-root .env (the single source of truth)
// if it exists. In production, DATABASE_URL is injected into the environment
// directly and no file is present — so this is optional and never required.
// This is the web PROCESS loading its own environment; the db package stays a
// pure consumer of process.env.
const rootEnv = resolve(process.cwd(), "../../.env");
if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

const nextConfig: NextConfig = {
  // Compile the workspace packages from their TypeScript source instead of
  // requiring a separate build step for them.
  transpilePackages: ["@webhook/db", "@webhook/shared"],
};

export default nextConfig;
