import { describe, expect, it } from "vitest";

import {
  DELIVERY_UPDATE_CHANNEL,
  parseDeliveryUpdate,
  serializeDeliveryUpdate,
  toBrowserPayload,
  type DeliveryUpdateNotification,
} from "@webhook/shared";

// Pure notification-contract unit tests — no DB, no network.

describe("Phase 8 — notification contract", () => {
  it("P8-1a: a valid notification round-trips through serialize/parse", () => {
    const n: DeliveryUpdateNotification = {
      accountId: "acc-1",
      deliveryId: "del-1",
      eventId: "evt-1",
      kind: "attempted",
    };
    expect(parseDeliveryUpdate(serializeDeliveryUpdate(n))).toEqual(n);
  });

  it("P8-1b: the browser payload drops accountId (IDs + kind only)", () => {
    const browser = toBrowserPayload({
      accountId: "acc-1",
      deliveryId: "del-1",
      eventId: "evt-1",
      kind: "created",
    });
    expect(browser).toEqual({ deliveryId: "del-1", eventId: "evt-1", kind: "created" });
    expect("accountId" in browser).toBe(false);
  });

  it("P8-1c: malformed payloads are safely rejected (null, not a throw)", () => {
    expect(parseDeliveryUpdate("not json")).toBeNull();
    expect(parseDeliveryUpdate("{}")).toBeNull();
    expect(parseDeliveryUpdate(JSON.stringify(["array"]))).toBeNull();
    expect(parseDeliveryUpdate(JSON.stringify(null))).toBeNull();
    // unknown kind
    expect(
      parseDeliveryUpdate(
        JSON.stringify({ accountId: "a", deliveryId: "d", eventId: "e", kind: "exploded" })
      )
    ).toBeNull();
    // empty required id
    expect(
      parseDeliveryUpdate(
        JSON.stringify({ accountId: "a", deliveryId: "", eventId: "e", kind: "created" })
      )
    ).toBeNull();
    // missing field
    expect(
      parseDeliveryUpdate(JSON.stringify({ accountId: "a", deliveryId: "d", kind: "created" }))
    ).toBeNull();
  });

  it("P8-1d: the channel is a single static constant", () => {
    expect(DELIVERY_UPDATE_CHANNEL).toBe("delivery_updates");
  });
});
