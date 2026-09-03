import { describe, expect, it } from "vitest";

import {
  classifyAddress,
  resolveAndValidateHost,
  validateEndpointUrlSyntax,
  type LookupAllFn,
} from "@webhook/shared";

// Pure SSRF policy unit tests (classification + URL syntax) plus resolve/validate
// with an INJECTED resolver — no real DNS, fully deterministic.

describe("Phase 6 — IP address classification", () => {
  it("P6-N1: public (globally-routable) addresses are safe", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "9.9.9.9", "2606:4700::1111"]) {
      expect(classifyAddress(ip).safe).toBe(true);
    }
  });

  it("P6-N2: private / internal / reserved IPv4 are unsafe", () => {
    for (const ip of [
      "127.0.0.1", // loopback
      "10.1.2.3", // private
      "172.16.5.5", // private
      "192.168.1.1", // private
      "169.254.169.254", // link-local / cloud metadata
      "100.64.0.1", // CGNAT
      "0.0.0.0", // unspecified
      "224.0.0.1", // multicast
      "255.255.255.255", // broadcast
    ]) {
      expect(classifyAddress(ip).safe, ip).toBe(false);
    }
  });

  it("P6-N3: internal IPv6 are unsafe", () => {
    for (const ip of ["::1", "fc00::1", "fd12::3", "fe80::1", "::"]) {
      expect(classifyAddress(ip).safe, ip).toBe(false);
    }
  });

  it("P6-N4: IPv4-mapped IPv6 is unwrapped and classified as IPv4", () => {
    expect(classifyAddress("::ffff:127.0.0.1").safe).toBe(false); // maps to loopback
    expect(classifyAddress("::ffff:10.0.0.1").safe).toBe(false); // maps to private
    expect(classifyAddress("::ffff:169.254.169.254").safe).toBe(false); // metadata
    expect(classifyAddress("::ffff:8.8.8.8").safe).toBe(true); // maps to public
  });
});

describe("Phase 6 — endpoint URL syntax policy", () => {
  it("P6-N5: accepts an https URL with a hostname", () => {
    const r = validateEndpointUrlSyntax("https://api.customer.com/webhook");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.hostname).toBe("api.customer.com");
  });

  it("P6-N6: rejects http (policy)", () => {
    const r = validateEndpointUrlSyntax("http://api.customer.com/webhook");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("policy");
  });

  it("P6-N7: rejects embedded credentials (policy)", () => {
    const r = validateEndpointUrlSyntax("https://user:pass@api.customer.com/webhook");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("policy");
  });

  it("P6-N8: rejects missing / malformed URLs (malformed)", () => {
    for (const url of ["", "   ", "not a url", null, 123]) {
      const r = validateEndpointUrlSyntax(url as unknown);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe("malformed");
    }
  });
});

// A resolver that returns a fixed set of addresses regardless of hostname.
function fakeLookup(addrs: { address: string; family: number }[]): LookupAllFn {
  return async () => addrs;
}

describe("Phase 6 — resolve + validate host", () => {
  it("P6-N9: a hostname resolving only to a public IP is accepted and pinned", async () => {
    const r = await resolveAndValidateHost("safe.example", {
      lookup: fakeLookup([{ address: "9.9.9.9", family: 4 }]),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pinnedIp).toBe("9.9.9.9");
  });

  it("P6-N10: if ANY resolved address is unsafe, the whole host is rejected", async () => {
    const r = await resolveAndValidateHost("safe.example", {
      lookup: fakeLookup([
        { address: "9.9.9.9", family: 4 }, // public
        { address: "127.0.0.1", family: 4 }, // loopback — poisons the whole set
      ]),
    });
    expect(r.ok).toBe(false);
  });

  it("P6-N11: IP-literal hosts are validated directly (no DNS)", async () => {
    expect((await resolveAndValidateHost("127.0.0.1")).ok).toBe(false);
    expect((await resolveAndValidateHost("[::1]")).ok).toBe(false);
    const ok = await resolveAndValidateHost("8.8.8.8");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.pinnedIp).toBe("8.8.8.8");
  });

  it("P6-N12: an empty DNS answer is rejected", async () => {
    const r = await resolveAndValidateHost("nowhere.example", { lookup: fakeLookup([]) });
    expect(r.ok).toBe(false);
  });
});
