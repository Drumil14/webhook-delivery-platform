import { describe, expect, it } from "vitest";

import {
  DEMO_RETRY_POLICY,
  PRODUCTION_RETRY_POLICY,
  baseRetryDelayMs,
  calculateRetryDelay,
} from "@webhook/shared";

const MIN = 60_000;
const HOUR = 60 * MIN;

describe("Phase 5 — retry policy math", () => {
  it("P5-1: nominal exponential progression + cap", () => {
    // Demo: 2s, 6s, 18s, 30s (cap), 30s (cap)
    expect(baseRetryDelayMs(2, DEMO_RETRY_POLICY)).toBe(2_000);
    expect(baseRetryDelayMs(3, DEMO_RETRY_POLICY)).toBe(6_000);
    expect(baseRetryDelayMs(4, DEMO_RETRY_POLICY)).toBe(18_000);
    expect(baseRetryDelayMs(5, DEMO_RETRY_POLICY)).toBe(30_000);
    expect(baseRetryDelayMs(6, DEMO_RETRY_POLICY)).toBe(30_000);

    // Production: 1m, 4m, 16m, ~1h, ~4.3h, ~17h (never hits 24h cap in 7 attempts)
    expect(baseRetryDelayMs(2, PRODUCTION_RETRY_POLICY)).toBe(1 * MIN);
    expect(baseRetryDelayMs(3, PRODUCTION_RETRY_POLICY)).toBe(4 * MIN);
    expect(baseRetryDelayMs(4, PRODUCTION_RETRY_POLICY)).toBe(16 * MIN);
    expect(baseRetryDelayMs(5, PRODUCTION_RETRY_POLICY)).toBe(64 * MIN); // ~1h
    expect(baseRetryDelayMs(6, PRODUCTION_RETRY_POLICY)).toBe(256 * MIN); // ~4.3h
    expect(baseRetryDelayMs(7, PRODUCTION_RETRY_POLICY)).toBe(1024 * MIN); // ~17h
    expect(baseRetryDelayMs(7, PRODUCTION_RETRY_POLICY)).toBeLessThan(24 * HOUR);
  });

  it("P5-2: jitter stays within +/-20% bounds", () => {
    const base = baseRetryDelayMs(2, DEMO_RETRY_POLICY); // 2000

    expect(calculateRetryDelay({ nextAttemptNumber: 2, policy: DEMO_RETRY_POLICY, random: () => 0 })).toBe(1_600); // -20%
    expect(calculateRetryDelay({ nextAttemptNumber: 2, policy: DEMO_RETRY_POLICY, random: () => 0.5 })).toBe(2_000); // center
    expect(calculateRetryDelay({ nextAttemptNumber: 2, policy: DEMO_RETRY_POLICY, random: () => 1 })).toBe(2_400); // +20%

    // Any random in [0,1] stays within bounds.
    for (let i = 0; i <= 20; i++) {
      const r = i / 20;
      const d = calculateRetryDelay({ nextAttemptNumber: 2, policy: DEMO_RETRY_POLICY, random: () => r });
      expect(d).toBeGreaterThanOrEqual(base * 0.8);
      expect(d).toBeLessThanOrEqual(base * 1.2);
    }
  });
});
