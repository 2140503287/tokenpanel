import { test, expect, describe } from "bun:test";
import {
  availableMicros,
  wouldReserveSucceed,
} from "../reservation.ts";

describe("availableMicros / wouldReserveSucceed", () => {
  test("available = amount - reserved", () => {
    expect(availableMicros({ amountMicros: 1000, reservedMicros: 200 })).toBe(800);
    expect(availableMicros({ amountMicros: 100, reservedMicros: 0 })).toBe(100);
    expect(availableMicros({ amountMicros: 50 })).toBe(50);
    // Never negative available.
    expect(availableMicros({ amountMicros: 10, reservedMicros: 50 })).toBe(0);
  });

  test("wouldReserveSucceed: currency mismatch", () => {
    const r = wouldReserveSucceed(
      { amountMicros: 1000, reservedMicros: 0, currency: "USD" },
      100,
      "EUR",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("currency_mismatch");
  });

  test("wouldReserveSucceed: insufficient available (held reduces capacity)", () => {
    const r = wouldReserveSucceed(
      { amountMicros: 1000, reservedMicros: 900, currency: "USD" },
      200,
      "USD",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("insufficient_available");
  });

  test("wouldReserveSucceed: amount would pass but available fails", () => {
    // amount 1000 >= need 100 but reserved 950 → available 50.
    const snap = { amountMicros: 1000, reservedMicros: 950, currency: "USD" };
    expect(snap.amountMicros >= 100).toBe(true);
    expect(wouldReserveSucceed(snap, 100, "USD").ok).toBe(false);
  });

  test("wouldReserveSucceed: zero need always ok", () => {
    expect(
      wouldReserveSucceed(
        { amountMicros: 0, reservedMicros: 0, currency: "USD" },
        0,
        "USD",
      ).ok,
    ).toBe(true);
  });

  test("wouldReserveSucceed: sufficient available", () => {
    expect(
      wouldReserveSucceed(
        { amountMicros: 1000, reservedMicros: 100, currency: "USD" },
        500,
        "USD",
      ).ok,
    ).toBe(true);
  });
});
