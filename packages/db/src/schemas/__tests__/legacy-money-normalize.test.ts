import { test, expect } from "bun:test";
import { normalizeLegacyMoneyFields } from "../legacy-money-normalize.ts";

type Balance = {
  amountMicros: number;
  reservedMicros: number;
  currency: string;
  amountUnits?: number;
  amountMinor?: number;
};

test("balance minor → micros (USD ×10,000), legacy keys dropped", () => {
  const out = normalizeLegacyMoneyFields({
    balance: { amountMinor: 1000, reservedMinor: 50, currency: "USD" },
  }) as { balance: Balance };
  expect(out.balance.amountMicros).toBe(10_000_000);
  expect(out.balance.reservedMicros).toBe(500_000);
  expect(out.balance.amountUnits).toBeUndefined();
  expect(out.balance.amountMinor).toBeUndefined();
  expect(out.balance.currency).toBe("USD");
});

test("non-balance scalar: units → micros, both legacy keys dropped", () => {
  const out = normalizeLegacyMoneyFields({
    amountUnits: 5,
    amountMinor: 9,
    currency: "USD",
  }) as { amountMicros: number; amountUnits?: number; amountMinor?: number };
  expect(out.amountMicros).toBe(50_000);
  expect(out.amountUnits).toBeUndefined();
  expect(out.amountMinor).toBeUndefined();
});

test("balance prefers Minor over stale Units, then rescales to micros", () => {
  const out = normalizeLegacyMoneyFields({
    balance: {
      amountUnits: 1000,
      amountMinor: 900,
      reservedUnits: 10,
      reservedMinor: 5,
      currency: "USD",
    },
  }) as { balance: Balance };
  expect(out.balance.amountMicros).toBe(9_000_000); // 900 minor wins
  expect(out.balance.reservedMicros).toBe(50_000);
});

test("existing micros win over units (new-writer truth)", () => {
  const out = normalizeLegacyMoneyFields({
    balance: { amountMicros: 123, amountUnits: 999, currency: "USD" },
  }) as { balance: Balance };
  expect(out.balance.amountMicros).toBe(123);
  expect(out.balance.amountUnits).toBeUndefined();
});

test("currency-aware factor: JPY ×1,000,000, KWD ×1,000", () => {
  const jpy = normalizeLegacyMoneyFields({
    balance: { amountUnits: 1, currency: "JPY" },
  }) as { balance: Balance };
  expect(jpy.balance.amountMicros).toBe(1_000_000);
  const kwd = normalizeLegacyMoneyFields({
    balance: { amountUnits: 1, currency: "KWD" },
  }) as { balance: Balance };
  expect(kwd.balance.amountMicros).toBe(1_000);
});

test("model entry schedule leaves → micros", () => {
  const out = normalizeLegacyMoneyFields({
    currency: "USD",
    entries: [
      {
        id: "e1",
        price: { inputMinorPerMillion: 100, outputMinorPerMillion: 200 },
        cost: { inputMinorPerMillion: 50, outputUnitsPerMillion: 80 },
      },
    ],
  }) as {
    entries: Array<{
      price: Record<string, number>;
      cost: Record<string, number>;
    }>;
  };
  expect(out.entries[0]!.price.inputMicrosPerMillion).toBe(1_000_000);
  expect(out.entries[0]!.price.outputMicrosPerMillion).toBe(2_000_000);
  expect(out.entries[0]!.cost.inputMicrosPerMillion).toBe(500_000);
  expect(out.entries[0]!.cost.outputMicrosPerMillion).toBe(800_000);
  expect(out.entries[0]!.price.inputUnitsPerMillion).toBeUndefined();
  expect(out.entries[0]!.price.inputMinorPerMillion).toBeUndefined();
});

test("maps spend_minor dimension → spend_units on rules", () => {
  const out = normalizeLegacyMoneyFields({
    rateLimits: [{ id: "r1", dimension: "spend_minor", capValue: 1 }],
    rules: [{ id: "r2", dimension: "spend_minor", capValue: 2 }],
    dimension: "spend_minor",
  }) as {
    rateLimits: Array<{ dimension: string }>;
    rules: Array<{ dimension: string }>;
    dimension: string;
  };
  expect(out.rateLimits[0]!.dimension).toBe("spend_units");
  expect(out.rules[0]!.dimension).toBe("spend_units");
  expect(out.dimension).toBe("spend_units");
});

test("outbox context money keys + schedules → micros (context currency)", () => {
  const out = normalizeLegacyMoneyFields({
    context: {
      currency: "USD",
      priceMinor: 10,
      reservedMinor: 3,
      priceSchedule: { inputMinorPerMillion: 1, outputMinorPerMillion: 2 },
    },
  }) as {
    context: {
      priceMicros: number;
      reservedMicros: number;
      priceSchedule: Record<string, number>;
    };
  };
  expect(out.context.priceMicros).toBe(100_000);
  expect(out.context.reservedMicros).toBe(30_000);
  expect(out.context.priceSchedule.inputMicrosPerMillion).toBe(10_000);
});
