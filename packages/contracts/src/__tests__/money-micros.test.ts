import { test, expect } from "bun:test";
import {
  MICROS_PER_MAJOR,
  microsPerMinor,
  minorToMicros,
  parseMajorToMicros,
  formatMicrosToMajor,
  moneyMicrosSchema,
} from "../money-micros.ts";

test("parseMajorToMicros: exact, no float error", () => {
  expect(parseMajorToMicros("0.15")).toBe(150_000);
  expect(parseMajorToMicros("3")).toBe(3_000_000);
  expect(parseMajorToMicros("3.00")).toBe(3_000_000);
  expect(parseMajorToMicros("0.005")).toBe(5_000);
  expect(parseMajorToMicros("0.000001")).toBe(1);
  expect(parseMajorToMicros("1000000")).toBe(1_000_000_000_000);
  // The canonical float trap: 0.15 * 1e6 === 149999.99999999997 in JS.
  expect(parseMajorToMicros("0.15")).not.toBe(Math.round(0.15 * 1e6) - 1);
});

test("parseMajorToMicros: whitespace, leading dot, plus sign", () => {
  expect(parseMajorToMicros("  0.15  ")).toBe(150_000);
  expect(parseMajorToMicros(".5")).toBe(500_000);
  expect(parseMajorToMicros("+2")).toBe(2_000_000);
});

test("parseMajorToMicros: rejects empty / non-numeric / multi-dot", () => {
  for (const bad of ["", "   ", "abc", "1.2.3", "1e3", "0x10", "--1", "1,5"]) {
    expect(() => parseMajorToMicros(bad)).toThrow();
  }
});

test("parseMajorToMicros: rejects >6 fractional places (sub-micro)", () => {
  expect(() => parseMajorToMicros("1.2345678")).toThrow();
  expect(() => parseMajorToMicros("0.0000001")).toThrow();
  expect(parseMajorToMicros("1.234567")).toBe(1_234_567);
});

test("parseMajorToMicros: negative rejected unless allowed", () => {
  expect(() => parseMajorToMicros("-0.1")).toThrow();
  expect(parseMajorToMicros("-0.1", { allowNegative: true })).toBe(-100_000);
  expect(parseMajorToMicros("-3", { allowNegative: true })).toBe(-3_000_000);
});

test("formatMicrosToMajor: integer division + trimmed zeros", () => {
  expect(formatMicrosToMajor(150_000)).toBe("0.15");
  expect(formatMicrosToMajor(300)).toBe("0.0003");
  expect(formatMicrosToMajor(3_000_000)).toBe("3");
  expect(formatMicrosToMajor(0)).toBe("0");
  expect(formatMicrosToMajor(1)).toBe("0.000001");
  expect(formatMicrosToMajor(1_234_567)).toBe("1.234567");
  expect(formatMicrosToMajor(-150_000)).toBe("-0.15");
});

test("round-trip parse↔format is exact", () => {
  for (const s of ["0.15", "3", "0.005", "0.000001", "123.456789", "0"]) {
    expect(formatMicrosToMajor(parseMajorToMicros(s))).toBe(s);
  }
});

test("microsPerMinor / minorToMicros: currency-aware factors", () => {
  expect(microsPerMinor(2)).toBe(10_000); // USD/EUR/GBP
  expect(microsPerMinor(0)).toBe(1_000_000); // JPY/KRW
  expect(microsPerMinor(3)).toBe(1_000); // KWD/BHD/OMR
  expect(minorToMicros(1, 2)).toBe(10_000); // 1 cent → 10,000 micros
  expect(minorToMicros(1, 0)).toBe(1_000_000); // 1 yen → 1,000,000 micros
  expect(minorToMicros(1, 3)).toBe(1_000); // 1 fils → 1,000 micros
  expect(minorToMicros(5, 2)).toBe(50_000); // the 5-unit E2E debit → $0.05
  expect(() => microsPerMinor(-1)).toThrow();
  expect(() => microsPerMinor(7)).toThrow();
  expect(() => minorToMicros(1.5, 2)).toThrow();
});

test("MoneyMicros schema: non-negative integer only", () => {
  expect(moneyMicrosSchema.safeParse(0).success).toBe(true);
  expect(moneyMicrosSchema.safeParse(150_000).success).toBe(true);
  expect(moneyMicrosSchema.safeParse(-1).success).toBe(false);
  expect(moneyMicrosSchema.safeParse(1.5).success).toBe(false);
  expect(moneyMicrosSchema.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
});

test("grain constant is 10^6", () => {
  expect(MICROS_PER_MAJOR).toBe(1_000_000);
});
